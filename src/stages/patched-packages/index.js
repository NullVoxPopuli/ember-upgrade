import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolvePackage } from "#installed.js";
import { patchedPackage, patchKeys, removePatches } from "#manager-settings.js";
import { editPackageJson, setDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

/**
 * @param {Project} project
 * @returns {{ name: string, version: string }[]} the packages with a pnpm patch for any version, and the version that the app has now
 */
function unpinned(project) {
  /** @type {{ name: string, version: string }[]} */
  let found = [];

  for (let key of patchKeys(project)) {
    if (key.indexOf("@", key.startsWith("@") ? 1 : 0) !== -1) continue;

    let range = project.dependency(key);
    let directory = resolvePackage(project.directory, key);

    if (!range || !directory) continue;

    let version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;

    if (range !== version) found.push({ name: key, version });
  }

  return found;
}

/**
 * A pnpm patch changes the files of the version that the app has. An install of the upgrade can resolve a newer
 * version of the range, where the patch does not apply and the install fails, so the package stays at that version.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "patched-packages",
  label: "Pin each package that a pnpm patch changes to the version that the patch is for",
  needsInstall: true,

  /**
   * Without an install, the version is unknown, so a range that is no exact version is enough.
   * The run comes after the install, and reads the version.
   */
  detect(project) {
    return patchKeys(project).some((key) => {
      let range = project.dependency(key);

      return Boolean(range) && !/^\d+\.\d+\.\d+$/.test(String(range));
    });
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let packages = unpinned(project);

    editPackageJson(project, (pkg) => {
      for (let { name, version } of packages) setDependency(pkg, name, version);
    });

    for (let { name, version } of packages) {
      recordProgress(project, {
        id: `${name}: patch`,
        status: "pinned",
        note:
          `${name} has a pnpm patch for the version that the app had, so it stays at ${version}. ` +
          "When you update it, update or remove the patch.",
      });
    }

    return [];
  },
};

/**
 * A patch is for the version that the app had. After an update to another version, it no longer applies,
 * and pnpm stops the install on it.
 *
 * @param {Project} project
 * @param {string[]} names the packages that an update moved to another version
 */
export function dropPatches(project, names) {
  let patched = new Set(patchKeys(project).map(patchedPackage));

  for (let name of names) {
    if (!patched.has(name)) continue;

    let files = removePatches(project, name);

    recordProgress(project, {
      id: `${name}: patch`,
      status: "removed",
      note:
        `The update of ${name} removed ${files.join(", ")}, the pnpm patch for the version before it, which no longer applies. ` +
        "Check whether the new version still needs what the patch changed. The patch is in the git history.",
    });
  }
}
