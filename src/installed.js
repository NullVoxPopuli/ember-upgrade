import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { dependencyNames } from "#package-json.js";

/** @typedef {import('#project.js').Project} Project */

/**
 * @param {string} from a folder
 * @param {string} name
 * @returns {string | undefined} the folder that Node finds for `name` from `from`, without symlinks
 */
export function resolvePackage(from, name) {
  for (let directory = from; ; directory = dirname(directory)) {
    let candidate = join(directory, "node_modules", name);

    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(directory) === directory) return;
  }
}

/**
 * The app's installed dependencies, and the dependencies of each Ember addon among them, at any depth.
 * Each copy of a package is its own entry.
 *
 * @param {Project} project
 * @returns {{ directory: string, manifest: Record<string, any> }[]}
 */
export function installedAddonTree(project) {
  let app = realpathSync(project.directory);
  /** @type {{ directory: string, manifest: Record<string, any> }[]} */
  let found = [];
  let seen = new Set();

  let visit = (/** @type {string | undefined} */ directory) => {
    if (!directory || seen.has(directory)) return;

    seen.add(directory);
    found.push({
      directory,
      manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
    });
  };

  for (let name of dependencyNames(project.packageJson)) visit(resolvePackage(app, name));

  for (let index = 0; index < found.length; index++) {
    let { directory, manifest } = found[index];

    if (!manifest.keywords?.includes("ember-addon")) continue;

    for (let name of Object.keys(manifest.dependencies ?? {})) {
      visit(resolvePackage(directory, name));
    }
  }

  return found;
}
