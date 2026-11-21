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
 * @returns {Map<string, string>} each package that the app's code imports without declaring it, with its installed version
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

  declared.add(String(manifest.name));

  for (let file of project.files(SOURCES)) {
    for (let match of project.read(file).matchAll(SPECIFIER)) {
      let name = packageName(String(match[1]));

      if (declared.has(name) || missing.has(name) || name.startsWith("node:")) continue;
      if (inEmberSource(project, name)) continue;

      let version = installedVersion(project, name);

      if (version) missing.set(name, version);
    }
  }

  return missing;
}

/**
 * The app imports packages that it does not declare, such as `@ember-data/model` next to `ember-data`.
 * Only the package manager's hoisting made them resolve, and it can resolve another copy than the
 * one the declared packages use (two copies of WarpDrive on rust-lang/crates.io).
 * Each one becomes a dependency at the installed version.
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
      for (let [name, version] of missing) setDependency(pkg, name, `^${version}`);
    });

    recordProgress(project, {
      id: "declare-imports",
      status: "added",
      note:
        `The app imports ${Array.from(missing.keys()).join(", ")} without declaring them. ` +
        "They are dependencies now, at the installed versions.",
    });

    return [];
  },
};
