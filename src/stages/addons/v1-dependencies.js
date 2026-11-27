import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolvePackage } from "#installed.js";
import { dependencyNames, editPackageJson, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { readProgress, recordProgress } from "#progress.js";
import { minorOf } from "#version.js";
import { isV1Addon } from "./known.js";
import { allowsMajor } from "./updates.js";

/** @typedef {import('#project.js').Project} Project */

const BLOCKED_ID = "v1-dependencies: blocked";
/** @typedef {{ version: string, dependencies?: Record<string, string>, peerDependencies?: Record<string, string> }} Release */

/**
 * @param {string} directory
 * @returns {Record<string, any>}
 */
function manifestAt(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

/**
 * @param {string | undefined} version
 * @returns {number | undefined}
 */
function majorOf(version) {
  return minorOf(version)?.[0];
}

/**
 * @param {string} range
 * @param {number} major
 * @returns {boolean} the peer range accepts the major
 */
function accepts(range, major) {
  return range === "*" || /^>=?/.test(range.trim()) || allowsMajor(range, major);
}

/**
 * The v2 addons of the app whose installed release depends on a v1 addon, with the release that does not,
 * and the addons whose peer range must move with them, such as ember-power-select with ember-basic-dropdown.
 *
 * @param {Project} project
 * @returns {{ updates: Map<string, Release>, blocked: string[] }}
 */
export function plannedUpdates(project) {
  /** @type {Map<string, Release>} */
  let updates = new Map();
  /** @type {string[]} */
  let blocked = [];
  /** @type {Map<string, Record<string, any>>} */
  let installed = new Map();

  for (let name of dependencyNames(project.packageJson)) {
    let directory = resolvePackage(project.directory, name);

    if (directory) installed.set(name, Object.assign(manifestAt(directory), { directory }));
  }

  for (let [name, manifest] of installed) {
    if (manifest["ember-addon"]?.version !== 2) continue;

    let v1 = Object.keys(manifest.dependencies ?? {}).filter((dependency) => {
      let directory = resolvePackage(manifest.directory, dependency);

      return directory && isV1Addon(manifestAt(directory));
    });

    if (v1.length === 0) continue;

    let release = /** @type {Release | undefined} */ (published(name));
    let current = majorOf(manifest.version);
    let latest = majorOf(release?.version);

    if (!release || current === undefined || latest === undefined || latest <= current) continue;
    if (v1.some((dependency) => release.dependencies?.[dependency])) continue;

    updates.set(name, release);
  }

  /**
   * An addon whose peer range on an updated addon rejects its new major moves to a release that accepts it.
   */
  for (let changed = updates.size > 0; changed;) {
    changed = false;

    for (let [name, manifest] of installed) {
      if (updates.has(name)) continue;

      let rejected = Array.from(updates).filter(([peer, release]) => {
        let range = manifest.peerDependencies?.[peer];
        let major = majorOf(release.version);

        return typeof range === "string" && major !== undefined && !accepts(range, major);
      });

      if (rejected.length === 0) continue;

      let release = /** @type {Release | undefined} */ (published(name));
      let fits =
        release &&
        rejected.every(([peer, update]) => {
          let range = release.peerDependencies?.[peer];

          return typeof range === "string" && accepts(range, Number(majorOf(update.version)));
        });

      if (!release || !fits) {
        blocked.push(`${name}: no release accepts ${rejected.map(([peer]) => peer).join(", ")}`);
        continue;
      }

      updates.set(name, release);
      changed = true;
    }
  }

  for (let [name, release] of updates) {
    for (let [peer, range] of Object.entries(release.peerDependencies ?? {})) {
      let version = updates.get(peer)?.version ?? installed.get(peer)?.version;
      let major = majorOf(version);

      if (major !== undefined && peer !== "ember-source" && !accepts(String(range), major)) {
        blocked.push(`${name} ${release.version} needs ${peer} ${range}`);
      }
    }
  }

  if (blocked.length > 0) return { updates: new Map(), blocked };

  /**
   * The stage runs before the install, so the ranges of package.json tell whether an update is done.
   */
  for (let [name, release] of updates) {
    let declared = majorOf(project.dependency(name));
    let target = majorOf(release.version);

    if (declared !== undefined && target !== undefined && declared >= target) updates.delete(name);
  }

  return { updates, blocked };
}

/**
 * @param {Project} project
 * @returns {boolean} the progress file already lists the blocked updates
 */
function blockedRecorded(project) {
  return readProgress(project).some((entry) => entry.id === BLOCKED_ID);
}

/**
 * The Vite build of ember.nvp loads no v1 addons, also not as a dependency of a v2 addon,
 * such as @embroider/util of ember-basic-dropdown 8. A later stage can make a newer release fit,
 * such as ember-concurrency 5 for ember-power-select 9, so this runs before ember-nvp.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "v1-dependencies",
  label:
    "Update the v2 addons that still depend on a v1 addon, with the addons that move with them",
  needsInstall: true,

  detect(project) {
    let { updates, blocked } = plannedUpdates(project);

    return updates.size > 0 || (blocked.length > 0 && !blockedRecorded(project));
  },

  async check(project) {
    let { blocked } = plannedUpdates(project);

    return {
      blockers: [],
      todo:
        blocked.length > 0
          ? [
              {
                title: "v2 addons that depend on a v1 addon, with no release that fits the app yet",
                where: blocked,
                action:
                  "Update the addons that their peer ranges name, then run ember-upgrade again.",
              },
            ]
          : [],
    };
  },

  async run(project) {
    let { updates, blocked } = plannedUpdates(project);

    editPackageJson(project, (pkg) => {
      for (let [name, release] of updates) setDependency(pkg, name, `^${release.version}`);
    });

    if (updates.size > 0) {
      recordProgress(project, {
        id: "v1-dependencies",
        status: "updated",
        note:
          "These addons depended on v1 addons, which the Vite build does not load, or moved with them: " +
          Array.from(updates, ([name, release]) => `${name} ${release.version}`).join(", ") +
          ". Check their changelogs for breaking changes.",
      });
    }

    if (blocked.length > 0) {
      recordProgress(project, {
        id: BLOCKED_ID,
        status: "check",
        note:
          "These v2 addons depend on v1 addons, which the Vite build does not load, and no newer release fits the app yet: " +
          `${blocked.join("; ")}.`,
      });
    }

    return blocked.length > 0
      ? [
          {
            title: "v2 addons that depend on a v1 addon, with no release that fits the app yet",
            where: blocked,
            action: "Update the addons that their peer ranges name, then run ember-upgrade again.",
          },
        ]
      : [];
  },
};
