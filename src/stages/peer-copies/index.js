import { realpathSync } from "node:fs";

import { installedAddonTree, resolvePackage } from "#installed.js";
import { addOverride, hasOverride } from "#manager-settings.js";
import { dependencyNames } from "#package-json.js";
import { recordProgress } from "#progress.js";
import { isV1Addon } from "#stages/addons/known.js";

/** @typedef {import('#project.js').Project} Project */

/**
 * The peer dependencies of v1 addons, anywhere in the tree, that resolve to another copy than the app's.
 *
 * @param {Project} project
 * @returns {{ name: string, range: string, addons: string[] }[]}
 */
export function peerMismatches(project) {
  let app = realpathSync(project.directory);
  let names = dependencyNames(project.packageJson);
  /** @type {Map<string, Set<string>>} */
  let found = new Map();

  for (let { directory, manifest } of installedAddonTree(project)) {
    if (!isV1Addon(manifest)) continue;

    for (let peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!names.includes(peer) || hasOverride(project, peer)) continue;

      let own = resolvePackage(directory, peer);

      if (!own || own === resolvePackage(app, peer)) continue;

      let addons = found.get(peer) ?? new Set();

      addons.add(manifest.name);
      found.set(peer, addons);
    }
  }

  return Array.from(found, ([name, addons]) => ({
    name,
    range: /** @type {string} */ (project.dependency(name)),
    addons: Array.from(addons).sort(),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Embroider stops the build when a v1 addon's peer dependency resolves to another copy than the app's.
 * Package managers can give an addon deep in the tree an older copy, so an override forces the app's version.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "peer-copies",
  label: "Force the app's copy of each peer dependency that v1 addons resolve to another copy",
  needsInstall: true,

  detect(project) {
    return peerMismatches(project).length > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    for (let { name, range, addons } of peerMismatches(project)) {
      addOverride(project, name, range);
      recordProgress(project, {
        id: name,
        status: "override",
        note:
          `An override forces the app's ${name} (${range}) for all dependencies, because ${addons.join(", ")} ` +
          "had another copy, and Embroider needs each v1 addon to share the app's copy. " +
          "Remove the override when these addons are v2 addons, or depend on the same version.",
      });
    }

    return [];
  },
};
