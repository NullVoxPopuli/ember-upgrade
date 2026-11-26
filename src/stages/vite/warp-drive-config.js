import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseProgram, walk } from "#ast.js";
import { buildFile } from "#config-files.js";
import { Edits } from "#edits.js";
import { resolvePackage } from "#installed.js";
import { editPackageJson, setDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";
import { atLeast } from "#version.js";

/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#ast.js').Node} Node */

const PACKAGE = "@warp-drive/build-config";

/**
 * The call of the app blueprints of ember-source 6. In the ember-cli build, ember-data's addon set the config,
 * and compatBuild needs the app to set it.
 */
const CALL = `
  const { setConfig } = await import('${PACKAGE}');
  setConfig(app, __dirname, {});`;

/**
 * The same call in a function that is not async. Node 24 loads the ES module of the package with `require()`.
 */
const REQUIRE_CALL = `
  const { setConfig } = require('${PACKAGE}');
  setConfig(app, __dirname, {});`;

/**
 * @param {string} source ember-cli-build
 * @param {string} file
 * @returns {string} the same source when it calls setConfig, has no `new EmberApp()`, or does not parse
 */
export function withWarpDriveConfig(source, file) {
  if (source.includes("setConfig(")) return source;

  let program = parseProgram(source, file);
  /** @type {{ start: number, end: number, name: string } | undefined} */
  let app;
  /** @type {Node[]} */
  let functions = [];

  walk(program, (node, parent) => {
    if (
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionDeclaration"
    ) {
      functions.push(node);
    }

    if (
      !app &&
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "NewExpression" &&
      node.init.callee.name === "EmberApp" &&
      parent?.type === "VariableDeclaration"
    ) {
      app = { start: parent.start, end: parent.end, name: node.id.name };
    }
  });

  if (!app) return source;

  let declaration = app;
  let enclosing = functions
    .filter((fn) => fn.start < declaration.start && declaration.end <= fn.end)
    .sort((a, b) => b.start - a.start)[0];
  let async = Boolean(enclosing?.async);
  let commonJs = /\brequire\(/.test(source);

  if (!async && !commonJs) return source;

  let edits = new Edits(source);
  let call = async ? CALL : REQUIRE_CALL;

  edits.insert(declaration.end, call.replace("setConfig(app,", `setConfig(${declaration.name},`));

  return edits.apply();
}

export const BABEL_CONFIGS = ["babel.config.mjs", "babel.config.js", "babel.config.cjs"];

/**
 * The Vite build compiles the v2 code of ember-data 5 with the macros of the Babel config,
 * so the app blueprints set the config in `buildMacros()`.
 *
 * @param {string} source a Babel config
 * @param {string} file
 * @returns {string} the same source when it calls setConfig, has no `buildMacros()` call, or does not parse
 */
export function withMacrosConfig(source, file) {
  if (source.includes("setConfig(")) return source;

  let program = parseProgram(source, file);
  /** @type {Node | undefined} */
  let call;

  walk(program, (node) => {
    if (!call && node.type === "CallExpression" && node.callee.name === "buildMacros") call = node;
  });

  if (!program || !call) return source;

  let found = /** @type {Node} */ (call);
  let options = found.arguments[0];
  let edits = new Edits(source);

  if (!options) {
    edits.replace(
      found,
      "buildMacros({\n  configure(config) {\n    setConfig(config, {});\n  },\n})",
    );
  } else if (options.type === "ObjectExpression") {
    let configure = options.properties.find(
      (/** @type {Node} */ property) => property.key?.name === "configure",
    );
    let fn =
      configure?.type === "Property" && configure.method ? configure.value : configure?.value;

    if (!configure) {
      edits.insert(options.start + 1, "\n  configure(config) {\n    setConfig(config, {});\n  },");
    } else if (
      (fn?.type === "FunctionExpression" || fn?.type === "ArrowFunctionExpression") &&
      fn.params[0]?.type === "Identifier" &&
      fn.body.type === "BlockStatement"
    ) {
      edits.insert(fn.body.start + 1, `\n    setConfig(${fn.params[0].name}, {});`);
    } else {
      return source;
    }
  } else {
    return source;
  }

  let imports = program.body.filter(
    (/** @type {Node} */ node) => node.type === "ImportDeclaration",
  );
  let last = imports[imports.length - 1];
  let line = file.endsWith(".cjs")
    ? `const { setConfig } = require('${PACKAGE}');`
    : `import { setConfig } from '${PACKAGE}';`;

  edits.insert(last ? last.end : 0, last ? `\n${line}` : `${line}\n`);

  return edits.apply();
}

/**
 * ember-data 5 builds its code with the config that `setConfig()` of @warp-drive/build-config gives.
 *
 * @param {Project} project
 */
export function addWarpDriveConfig(project) {
  let file = buildFile(project);

  if (!file || !atLeast(project.dependency("ember-data"), 5, 0)) return;

  let changed = false;

  for (let config of [file].concat(BABEL_CONFIGS)) {
    if (!project.has(config)) continue;

    let source = project.read(config);
    let output =
      config === file ? withWarpDriveConfig(source, config) : withMacrosConfig(source, config);

    if (output === source) continue;

    project.write(config, output);
    changed = true;
  }

  if (!changed) return;

  let emberData = resolvePackage(project.directory, "ember-data");
  let config = emberData ? resolvePackage(emberData, PACKAGE) : undefined;
  let version = config
    ? JSON.parse(readFileSync(join(config, "package.json"), "utf8")).version
    : undefined;

  editPackageJson(project, (pkg) => {
    if (!project.dependency(PACKAGE)) {
      setDependency(
        pkg,
        PACKAGE,
        version ? `^${version}` : String(project.dependency("ember-data")),
      );
    }
  });

  recordProgress(project, {
    id: `${PACKAGE}: setConfig`,
    status: "added",
    note:
      `ember-cli-build and the macros of the Babel config call setConfig() of ${PACKAGE}, as the app blueprints of ember-source 6 do. ` +
      "Set `compatWith` and the deprecations that the app has resolved there.",
    links: ["https://docs.warp-drive.io/api/@warp-drive/core/build-config/"],
  });
}
