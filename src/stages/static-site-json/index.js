import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { parseProgram, propertyName } from "#ast.js";
import { addVitePlugin, viteConfig } from "#config-files.js";
import { Edits } from "#edits.js";
import { resolvePackage } from "#installed.js";
import { editPackageJson, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";
import { PLUGIN_FILE, PLUGIN_SOURCE } from "./plugin-source.js";

/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#ast.js').Node} Node */

const LIBRARY = "broccoli-static-site-json";
const MERGE = "broccoli-merge-trees";
const HOOKS = new Set(["name", "isDevelopingAddon", "treeForPublic"]);

/**
 * @param {Node} statement
 * @returns {{ local: string, module: string } | undefined} `const X = require("module")`
 */
function requireOf(statement) {
  if (statement.type !== "VariableDeclaration" || statement.declarations.length !== 1) return;

  let [declarator] = statement.declarations;
  let init = declarator.init;

  if (
    declarator.id.type === "Identifier" &&
    init?.type === "CallExpression" &&
    init.callee.type === "Identifier" &&
    init.callee.name === "require" &&
    init.arguments[0]?.type === "Literal"
  ) {
    return { local: declarator.id.name, module: String(init.arguments[0].value) };
  }
}

/**
 * @param {Node} statement
 * @returns {Node | undefined} the object of `module.exports = { ... }`
 */
function exportsObject(statement) {
  let expression = statement.type === "ExpressionStatement" ? statement.expression : undefined;

  if (
    expression?.type === "AssignmentExpression" &&
    expression.left.type === "MemberExpression" &&
    expression.left.object.name === "module" &&
    expression.left.property.name === "exports" &&
    expression.right.type === "ObjectExpression"
  ) {
    return expression.right;
  }
}

/**
 * @param {Node} object
 * @param {string | undefined} merge the local name of broccoli-merge-trees
 * @param {string} library the local name of broccoli-static-site-json
 * @returns {Node | undefined} the trees that treeForPublic merges, or the one tree that it returns
 */
function publicTrees(object, merge, library) {
  let hook = object.properties.find(
    (/** @type {Node} */ property) => propertyName(property) === "treeForPublic",
  );
  let body = hook?.value?.body?.body ?? [];
  let returned =
    body.length === 1 && body[0].type === "ReturnStatement" ? body[0].argument : undefined;

  if (!returned) return;

  let callee = returned.callee?.type === "Identifier" ? returned.callee.name : undefined;

  if (
    (returned.type === "NewExpression" || returned.type === "CallExpression") &&
    callee === merge
  ) {
    return returned.arguments.length === 1 ? returned.arguments[0] : undefined;
  }

  if (returned.type === "Identifier" || (returned.type === "NewExpression" && callee === library)) {
    return returned;
  }
}

/**
 * @param {string} source
 * @param {Node} statement
 * @returns {{ start: number, end: number } | undefined} the `// eslint-disable-next-line` comment on the line above the statement,
 * which named a rule for the `require()` call
 */
function lintComment(source, statement) {
  let lineStart = source.lastIndexOf("\n", statement.start - 1) + 1;
  let previousStart = source.lastIndexOf("\n", lineStart - 2) + 1;
  let previous = source.slice(previousStart, lineStart - 1);
  let offset = previous.indexOf("//");

  if (offset === -1 || !previous.trim().startsWith("// eslint-disable-next-line")) return;

  return { start: previousStart + offset, end: lineStart - 1 };
}

/**
 * An in-repo addon that only adds broccoli-static-site-json trees to the public folder,
 * as a Vite plugin module that builds the same JSON files.
 *
 * @param {string} source the addon's index.js
 * @returns {string | undefined} undefined when the addon does anything else
 */
export function contentModule(source) {
  let program = parseProgram(source, "index.js");

  if (!program) return;

  /** @type {Node | undefined} */
  let exported;
  /** @type {Node | undefined} */
  let exportStatement;
  /** @type {Map<string, Node>} */
  let requires = new Map();

  for (let statement of /** @type {Node[]} */ (program.body)) {
    let required = requireOf(statement);

    if (required) {
      if (required.module !== LIBRARY && required.module !== MERGE) return;

      requires.set(required.module, statement);
      continue;
    }

    let object = exportsObject(statement);

    if (object) {
      exported = object;
      exportStatement = statement;
    }
  }

  let library = requires.get(LIBRARY);

  if (!exported || !exportStatement || !library) return;

  let object = /** @type {Node} */ (exported);

  if (
    !object.properties.every((/** @type {Node} */ property) =>
      HOOKS.has(propertyName(property) ?? ""),
    )
  ) {
    return;
  }

  let libraryName = /** @type {{ local: string }} */ (requireOf(library)).local;
  let mergeStatement = requires.get(MERGE);
  let mergeName = mergeStatement ? requireOf(mergeStatement)?.local : undefined;
  let trees = publicTrees(object, mergeName, libraryName);

  if (!trees) return;

  let list =
    trees.type === "ArrayExpression"
      ? source.slice(trees.start, trees.end)
      : `[${source.slice(trees.start, trees.end)}]`;
  let edits = new Edits(source);
  let specifier =
    libraryName === "StaticSiteJson" ? "StaticSiteJson" : `StaticSiteJson as ${libraryName}`;

  for (let statement of [library, mergeStatement]) {
    let comment = statement && lintComment(source, statement);

    if (comment) edits.removeLine(comment);
  }

  edits.replace(library, `import { ${specifier}, staticSiteJson } from "./static-site-json.mjs";`);

  if (mergeStatement) edits.removeLine(mergeStatement);

  edits.replace(/** @type {Node} */ (exportStatement), `export default staticSiteJson(${list});`);

  return edits.apply().replace(/^\s*['"]use strict['"];?\n+/, "");
}

/**
 * @param {Project} project
 * @returns {{ path: string, name: string, module: string }[]} the in-repo addons that the stage can move
 */
function contentAddons(project) {
  /** @type {string[]} */
  let paths =
    /** @type {{ paths?: string[] }} */ (project.packageJson["ember-addon"] ?? {}).paths ?? [];
  /** @type {{ path: string, name: string, module: string }[]} */
  let found = [];

  for (let path of paths) {
    let file = `${path}/index.js`;

    if (!project.has(file)) continue;

    let module = contentModule(project.read(file));

    if (module) found.push({ path, name: path.split("/").pop() ?? path, module });
  }

  return found;
}

/**
 * @param {string} name such as `content-generator`
 * @returns {string} such as `contentGenerator`
 */
function camelCase(name) {
  return name.replace(/[-_.]+(\w)/g, (_, letter) => letter.toUpperCase());
}

/**
 * ember-cli merged the public trees of in-repo addons into the build, and some apps make their content JSON there
 * with broccoli-static-site-json. Vite builds without in-repo addons, so a plugin in vite/ builds the same files.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "static-site-json",
  label:
    "Build the JSON of broccoli-static-site-json with a Vite plugin, in place of its in-repo addon",

  detect(project) {
    return Boolean(viteConfig(project)) && contentAddons(project).length > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let addons = contentAddons(project);
    /** @type {import('#types.js').Finding[]} */
    let todo = [];

    project.write(PLUGIN_FILE, PLUGIN_SOURCE);

    for (let addon of addons) {
      let file = `vite/${addon.name}.mjs`;
      let local = camelCase(addon.name);

      project.write(file, addon.module);

      let added = addVitePlugin(project, {
        importLine: `import ${local} from './${file}';`,
        call: local,
        specifier: `./${file}`,
      });

      if (!added) {
        todo.push({
          title: `Add the plugin of ${file} to the Vite config`,
          where: [viteConfig(project) ?? "vite.config.mjs"],
          action: `Import its default export, and add it to \`plugins\`.`,
        });
      }

      let installed = resolvePackage(
        join(project.directory, addon.path),
        "broccoli-static-site-json",
      );
      let version = installed
        ? JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version
        : published("broccoli-static-site-json")?.version;

      editPackageJson(project, (pkg) => {
        let paths = pkg["ember-addon"].paths.filter(
          (/** @type {string} */ path) => path !== addon.path,
        );

        if (paths.length > 0) pkg["ember-addon"].paths = paths;
        else delete pkg["ember-addon"].paths;

        if (Object.keys(pkg["ember-addon"]).length === 0) delete pkg["ember-addon"];
        if (!project.dependency(LIBRARY)) setDependency(pkg, LIBRARY, `^${version ?? "5.0.0"}`);
      });

      rmSync(join(project.directory, addon.path), { recursive: true, force: true });

      recordProgress(project, {
        id: `${addon.path}: static-site-json`,
        status: "moved",
        note:
          `The in-repo addon ${addon.path} made JSON files with broccoli-static-site-json. ` +
          `${file} makes the same files in the Vite build and the dev server, with ${PLUGIN_FILE}.`,
      });
    }

    return todo;
  },
};
