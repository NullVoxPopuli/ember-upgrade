import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { installedTree, resolvePackage } from "#installed.js";
import { addOverride, hasOverride, removeOverride } from "#manager-settings.js";
import { dependencyNames } from "#package-json.js";
import { install, packageManager } from "#process.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

/**
 * @param {string} directory
 * @returns {string} the version of the package in the folder
 */
function versionIn(directory) {
  return String(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version);
}

/**
 * @param {string} version
 * @returns {number}
 */
function majorOf(version) {
  return Number(version.split(".")[0]);
}

/**
 * @param {string} range such as `^7.28.10 || ^8.0.0`
 * @param {number} major
 * @returns {boolean} the range accepts a version of the major
 */
export function acceptsMajor(range, major) {
  return range.split("||").some((part) => {
    let text = part.trim();

    if (text === "" || text === "*" || text === "x") return true;

    /**
     * An upper bound such as `<8.0.0` leaves only the prereleases of 8.
     */
    let upper = /<\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);

    if (
      upper &&
      (major > Number(upper[1]) ||
        (major === Number(upper[1]) && !Number(upper[2]) && !Number(upper[3])))
    ) {
      return false;
    }

    let lower = /^>=?\s*v?(\d+)/.exec(text);

    if (lower) return Number(lower[1]) <= major;

    let exact = /^[\^~=]?\s*v?(\d+)/.exec(text);

    return Boolean(exact) && Number(exact?.[1]) === major;
  });
}

/**
 * The direct dependencies of the app that another package of the tree resolves to a copy of another major,
 * while its range also accepts the app's version.
 * A package manager reuses a version that the lockfile already has, so a package can keep an old major
 * after the app moves to a new one, such as a build plugin on Babel 7 in an app on Babel 8.
 *
 * @param {Project} project
 * @returns {{ name: string, range: string, users: string[] }[]}
 */
export function copyMismatches(project) {
  let app = realpathSync(project.directory);
  let names = new Set(dependencyNames(project.packageJson));
  /** @type {Map<string, { copy: string, major: number }>} */
  let appCopies = new Map();

  for (let name of names) {
    let copy = resolvePackage(app, name);

    if (copy) appCopies.set(name, { copy, major: majorOf(versionIn(copy)) });
  }

  /** @type {Map<string, Set<string>>} */
  let found = new Map();

  for (let { directory, manifest } of installedTree(project, () => true)) {
    /**
     * The peer dependencies resolve to the copy of the package that installs this one, which the peer-copies stage handles.
     */
    for (let [name, range] of Object.entries(manifest.dependencies ?? {})) {
      let own = appCopies.get(name);

      if (!own || hasOverride(project, name)) continue;

      let copy = resolvePackage(directory, name);

      if (!copy || copy === own.copy) continue;
      if (majorOf(versionIn(copy)) === own.major || !acceptsMajor(String(range), own.major))
        continue;

      let users = found.get(name) ?? new Set();

      users.add(String(manifest.name));
      found.set(name, users);
    }
  }

  return Array.from(found, ([name, users]) => ({
    name,
    range: /** @type {string} */ (project.dependency(name)),
    users: Array.from(users).sort(),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * pnpm takes an override for one parent, such as `@nullvoxpopuli/ember-vite>@babel/core`,
 * so the packages that need the old major keep it. The other package managers get one override for the whole tree.
 *
 * @param {Project} project
 * @param {{ name: string, range: string, users: string[] }[]} mismatches
 * @returns {Map<string, string>} the range of each override, by key
 */
function overrideKeys(project, mismatches) {
  /** @type {Map<string, string>} */
  let keys = new Map();

  for (let { name, range, users } of mismatches) {
    if (packageManager(project) !== "pnpm") {
      keys.set(name, range);
      continue;
    }

    for (let user of users) keys.set(`${user}>${name}`, range);
  }

  return keys;
}

/**
 * The overrides make the package manager resolve each copy again, and the lockfile keeps that resolution
 * after the overrides go, because each range accepts it.
 *
 * @param {Project} project
 * @returns {boolean} false when no copy needed it
 */
export function resolveCopies(project) {
  let mismatches = copyMismatches(project);

  if (mismatches.length === 0) return false;

  let keys = overrideKeys(project, mismatches);

  for (let [key, range] of keys) addOverride(project, key, range);

  if (!install(project)) throw new Error("The install with the overrides failed.");

  for (let [key] of keys) removeOverride(project, key);

  if (!install(project)) throw new Error("The install after the overrides failed.");

  recordProgress(project, {
    id: "dependency-copies",
    status: "resolved",
    note:
      "The lockfile kept older copies of these dependencies for packages whose ranges accept the app's version, " +
      "so they resolve to the app's version now: " +
      mismatches
        .map(({ name, range, users }) => `${name} ${range} (for ${users.join(", ")})`)
        .join(", ") +
      ".",
  });

  return true;
}

/**
 * @type {import('#types.js').Stage}
 */
export default {
  name: "dependency-copies",
  label:
    "Resolve again the dependencies that the app's packages keep at an older major than the app",
  needsInstall: true,

  detect(project) {
    return copyMismatches(project).length > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    resolveCopies(project);

    return [];
  },
};
