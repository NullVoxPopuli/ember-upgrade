import { dependencyNames, editPackageJson, setDependency } from "#package-json.js";

/** @typedef {import('#project.js').Project} Project */

/**
 * The first WarpDrive 5 release whose `@warp-drive/utilities/string` is ESM.
 * In 5.8, the module is CommonJS, so the Vite dev server loses its named exports, such as `irregular`.
 */
const TARGET = [5, 9, 1];

/**
 * @param {string} name
 */
function isWarpDrive(name) {
  return (
    name === "ember-data" || name.startsWith("@ember-data/") || name.startsWith("@warp-drive/")
  );
}

/**
 * @param {string | undefined} range
 * @returns {{ prefix: string, version: number[] } | undefined} the lowest version that a plain range allows
 */
function parseRange(range) {
  let match = range?.match(/^([~^]?)(\d+)\.(\d+)\.(\d+)$/);

  if (!match) return;

  return { prefix: match[1], version: [Number(match[2]), Number(match[3]), Number(match[4])] };
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];

  return 0;
}

/**
 * The WarpDrive and ember-data 5 packages before 5.9.1.
 * The packages that are not version 5, such as @ember-data/rfc395-data, have their own versions.
 *
 * @param {Project} project
 * @returns {Map<string, string>} the new range of each package
 */
export function warpDriveUpdates(project) {
  /** @type {Map<string, string>} */
  let updates = new Map();
  let pkg = JSON.parse(project.read("package.json"));

  for (let name of dependencyNames(pkg)) {
    if (!isWarpDrive(name)) continue;

    let range = parseRange(project.dependency(name));

    if (!range || range.version[0] !== TARGET[0] || compare(range.version, TARGET) >= 0) continue;

    updates.set(name, `${range.prefix}${TARGET.join(".")}`);
  }

  return updates;
}

/**
 * Moves WarpDrive 5 to 5.9.1, with the same range prefix.
 * All the packages move together, because each one depends on the exact version of the others.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "warp-drive-version",
  label: "Update WarpDrive 5 to 5.9.1, whose string utilities are ESM",

  detect(project) {
    return project.has("package.json") && warpDriveUpdates(project).size > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let updates = warpDriveUpdates(project);

    editPackageJson(project, (pkg) => {
      for (let [name, range] of updates) setDependency(pkg, name, range);
    });

    return [];
  },
};
