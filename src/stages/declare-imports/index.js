import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { editPackageJson, setDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const SOURCES = ["{app,tests}/**/*.{js,ts,gjs,gts}"];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"'./#][^"']*)["']/g;

/**
 * @param {string} specifier such as `@ember-data/adapter/error`
 * @returns {string} the package name, such as `@ember-data/adapter`
 */
export function packageName(specifier) {
  let parts = specifier.split("/");

  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : String(parts[0]);
}

/**
 * @param {Project} project
 * @param {string} name
 * @returns {string | undefined} the installed version, also when only the package manager's hoisting reaches it
 */
function installedVersion(project, name) {
  for (let directory of [
    join(project.directory, "node_modules", name),
    join(project.directory, "node_modules", ".pnpm", "node_modules", name),
  ]) {
    let manifest = join(directory, "package.json");

    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).version;
  }
}

/**
 * @param {Project} project
 * @param {string} name such as `@glimmer/tracking`
 * @returns {boolean} ember-source has the module, so it is not a package to install
 */
function inEmberSource(project, name) {
  let emberSource = join(project.directory, "node_modules", "ember-source");

  if (!existsSync(emberSource)) return false;

  let directory = realpathSync(emberSource);

  return ["dist/packages", "dist/dev/packages"].some((folder) =>
    existsSync(join(directory, folder, name)),
  );
}

/**
 * @param {Project} project
 * @param {Set<string>} declared
 * @returns {Map<string, string>} the range that a declared package asks for, for each of its dependencies
 */
function rangesOfDeclared(project, declared) {
  /** @type {Map<string, string>} */
  let ranges = new Map();

  for (let name of declared) {
    let manifest = join(project.directory, "node_modules", name, "package.json");

    if (!existsSync(manifest)) continue;

    let { dependencies = {} } = JSON.parse(readFileSync(manifest, "utf8"));

    for (let [dependency, range] of Object.entries(dependencies)) {
      if (!ranges.has(dependency)) ranges.set(dependency, String(range));
    }
  }

  return ranges;
}

/**
 * The range of a package that comes with a declared one, such as `@ember-data/model` with `ember-data`,
 * is the one that the declared package asks for, so both use one copy.
 * Otherwise it is the installed version.
 *
 * @param {Project} project
 * @returns {Map<string, string>} each package that the app's code imports without declaring it, with its range
 */
export function undeclaredImports(project) {
  let manifest = project.packageJson;
  let declared = new Set(
    Object.keys(
      Object.assign({}, manifest.dependencies, manifest.devDependencies, manifest.peerDependencies),
    ),
  );
  /** @type {Map<string, string>} */
  let missing = new Map();
  let ranges = rangesOfDeclared(project, declared);

  declared.add(String(manifest.name));

  for (let file of project.files(SOURCES)) {
    for (let match of project.read(file).matchAll(SPECIFIER)) {
      let name = packageName(String(match[1]));

      if (declared.has(name) || missing.has(name) || name.startsWith("node:")) continue;
      if (inEmberSource(project, name)) continue;

      let range = ranges.get(name) ?? installedVersion(project, name);

      if (range) missing.set(name, range);
    }
  }

  return missing;
}

/**
 * The app imports packages that it does not declare, such as `@ember-data/model` next to `ember-data`.
 * Only the package manager's hoisting made them resolve, and it can resolve another copy than the
 * one the declared packages use (two copies of WarpDrive on rust-lang/crates.io).
 * Each one becomes a dependency, with the range of the package that brought it, or its installed version.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "declare-imports",
  label: "Declare the packages that the app imports",

  detect(project) {
    return undeclaredImports(project).size > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let missing = undeclaredImports(project);

    editPackageJson(project, (pkg) => {
      for (let [name, range] of missing) setDependency(pkg, name, range);
    });

    recordProgress(project, {
      id: "declare-imports",
      status: "added",
      note:
        `The app imports ${Array.from(missing.keys()).join(", ")} without declaring them. ` +
        "They are dependencies now, with the ranges of the packages that brought them, or their installed versions.",
    });

    return [];
  },
};
