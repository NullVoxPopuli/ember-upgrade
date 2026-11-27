import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { parseProgram, walk } from "#ast.js";
import { buildFile } from "#config-files.js";
import { Edits } from "#edits.js";
import { appConfig } from "./content-for.js";

/** @typedef {import('#project.js').Project} Project */

/**
 * The environments of a build. The hook must import the same files in each one.
 */
const ENVIRONMENTS = ["production", "development"];

/**
 * The vendor files that the app can hold as text.
 */
const TEXT = /\.(css|js)$/;

/**
 * @typedef {object} VendorImport
 * @property {string} path such as `vendor/ember-toggle/base.css`
 * @property {string} [type] `test` for a test import
 */

/**
 * @param {unknown} value
 * @returns {object} an object that throws on each read, so a hook that reads build options does not run
 */
function unreadable(value) {
  return new Proxy(/** @type {object} */ (value), {
    get(_target, key) {
      throw new Error(`the hook reads ${String(key)}`);
    },
  });
}

/**
 * Runs a v1 addon's `included` hook, as ember-cli did, with an app that records each `app.import()`.
 *
 * @param {Project} project
 * @param {string} directory the installed addon
 * @returns {VendorImport[] | undefined} undefined when the hook does more than import the addon's own vendor files,
 * or imports other files in production than in development
 */
export function includedImports(project, directory) {
  let config = appConfig(project);

  if (!config) return;

  let manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  let require = createRequire(join(directory, "package.json"));
  let addon;

  try {
    addon = require(join(directory, manifest["ember-addon"]?.main ?? "index.js"));
  } catch {
    return;
  }

  if (typeof addon?.included !== "function") return;

  /** @type {string[]} */
  let results = [];

  for (let environment of ENVIRONMENTS) {
    /** @type {VendorImport[]} */
    let imports = [];
    let record = (/** @type {unknown} */ path, /** @type {{ type?: string }} */ options) => {
      /**
       * An object of paths for each environment, such as `{ development, production }`, stays with ember-cli.
       */
      if (typeof path !== "string") throw new Error("the hook imports a file for each environment");

      imports.push(options?.type ? { path, type: options.type } : { path });
    };
    let host = {
      root: project.directory,
      config: () => config(environment),
    };
    /**
     * ember-cli's app has the project too, which hooks such as torii's read for the app's config.
     */
    let app = {
      env: environment,
      import: record,
      options: unreadable({}),
      registry: unreadable({}),
      project: host,
    };
    let instance = Object.assign(Object.create(addon), {
      _super: { included() {} },
      import: record,
      project: host,
    });

    try {
      addon.included.call(instance, app);
    } catch {
      return;
    }

    results.push(JSON.stringify(imports));
  }

  if (results.some((result) => result !== results[0])) return;

  /** @type {VendorImport[]} */
  let imports = JSON.parse(results[0]);

  if (
    imports.some(
      (entry) =>
        !entry.path.startsWith("vendor/") ||
        !TEXT.test(entry.path) ||
        !existsSync(join(directory, entry.path)),
    )
  ) {
    return;
  }

  return imports;
}

/**
 * ember-cli merged each addon's vendor tree into the app's `vendor/`, so the addon's `app.import()` calls
 * become the app's own, after the `new EmberApp()` of ember-cli-build. The build-settings stage moves them into the app's code.
 *
 * @param {Project} project
 * @param {string} directory the installed addon
 * @param {VendorImport[]} imports
 * @returns {Record<string, string> | undefined} the vendor files and the new ember-cli-build; undefined when it has no `new EmberApp()`
 */
export function vendorFiles(project, directory, imports) {
  let file = buildFile(project);

  if (!file) return;

  let source = project.read(file);
  let program = parseProgram(source, file);
  /** @type {{ name: string, end: number } | undefined} */
  let app;

  walk(program, (node, parent) => {
    if (
      !app &&
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "NewExpression" &&
      node.init.callee.name === "EmberApp" &&
      parent?.type === "VariableDeclaration"
    ) {
      app = { name: node.id.name, end: parent.end };
    }
  });

  if (!app) return;

  let found = /** @type {{ name: string, end: number }} */ (app);
  let calls = imports.map((entry) => {
    let options = entry.type ? `, { type: ${JSON.stringify(entry.type)} }` : "";

    return `\n  ${found.name}.import(${JSON.stringify(entry.path)}${options});`;
  });
  let edits = new Edits(source);

  edits.insert(found.end, calls.join(""));

  /** @type {Record<string, string>} */
  let files = { [file]: edits.apply() };

  for (let entry of imports) {
    files[entry.path] = readFileSync(join(directory, entry.path), "utf8");
  }

  return files;
}
