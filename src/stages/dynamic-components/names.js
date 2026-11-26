import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { dependencyNames } from "#package-json.js";
import { addonsOf } from "#stages/app-tree/index.js";

/** @typedef {import('#project.js').Project} Project */

const MODULE = /\.(js|ts|gjs|gts|hbs)$/;

/**
 * @param {string} directory
 * @returns {string[]} the files under `directory`, relative to it
 */
function filesUnder(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)));
}

/**
 * @param {string} from
 * @param {string} name
 * @returns {boolean} Node finds `name` from `from`, in its node_modules or in a parent's
 */
function installed(from, name) {
  for (let directory = from; ; directory = dirname(directory)) {
    if (existsSync(join(directory, "node_modules", name, "package.json"))) return true;
    if (dirname(directory) === directory) return false;
  }
}

/**
 * @param {string} file a module under `components/` or `helpers/`, such as `x/index.js`
 * @returns {string} the name that a template calls, such as `x`
 */
function nameOf(file) {
  return file
    .split("\\")
    .join("/")
    .replace(MODULE, "")
    .replace(/\/(index|component|template)$/, "");
}

/**
 * @param {string} tree an app tree, such as the app's `app/`
 * @param {Set<string>} components
 * @param {Set<string>} helpers
 */
function addTree(tree, components, helpers) {
  for (let file of filesUnder(join(tree, "components"))) {
    if (MODULE.test(file)) components.add(nameOf(file));
  }

  for (let file of filesUnder(join(tree, "templates/components"))) {
    if (MODULE.test(file)) components.add(nameOf(file));
  }

  for (let file of filesUnder(join(tree, "helpers"))) {
    if (MODULE.test(file)) helpers.add(nameOf(file));
  }
}

/**
 * The components and helpers that a template can call by name:
 * the app's own, those of its in-repo addons, and those that its addons merge into the app.
 * It is undefined when a dependency is not installed, because that addon can add names too.
 *
 * @param {Project} project
 * @returns {{ components: Set<string>, helpers: Set<string>, addons: string[], packages: import('#stages/app-tree/index.js').Addon[] } | undefined}
 * addons has the name of each addon, without its scope
 */
export function templateNames(project) {
  for (let name of dependencyNames(project.packageJson)) {
    if (!installed(project.directory, name)) return;
  }

  /** @type {Set<string>} */
  let components = new Set();
  /** @type {Set<string>} */
  let helpers = new Set();

  addTree(join(project.directory, "app"), components, helpers);

  for (let lib of project.files(["lib/*/package.json"])) {
    addTree(join(project.directory, lib, "../app"), components, helpers);
  }

  /** @type {string[]} */
  let addons = [];
  let packages = addonsOf(project);

  for (let addon of packages) {
    addons.push(addon.name.replace(/^@[^/]+\//, ""));
    addTree(join(addon.directory, "app"), components, helpers);

    for (let entry of Object.keys(addon.manifest["ember-addon"]?.["app-js"] ?? {})) {
      let match = entry.match(/^\.\/(components|helpers)\/(.+)$/);

      if (match) (match[1] === "components" ? components : helpers).add(nameOf(match[2]));
    }
  }

  return { components, helpers, addons, packages };
}
