import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolvePackage } from "#installed.js";
import { dependencyNames, editPackageJson, setDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

/**
 * @param {Project} project
 * @returns {Map<string, { range: string, addons: string[] }>} each required peer dependency of the app's addons that the app does not declare
 */
export function missingPeers(project) {
  /** @type {Map<string, { range: string, addons: string[] }>} */
  let missing = new Map();

  for (let name of dependencyNames(project.packageJson)) {
    let directory = resolvePackage(project.directory, name);

    if (!directory) continue;

    let manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));

    if (!manifest.keywords?.includes("ember-addon")) continue;

    for (let [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (peer === "ember-source" || project.dependency(peer)) continue;
      if (manifest.peerDependenciesMeta?.[peer]?.optional) continue;

      let entry = missing.get(peer) ?? { range: String(range), addons: [] };

      entry.addons.push(name);
      missing.set(peer, entry);
    }
  }

  return missing;
}

/**
 * An addon's peer dependency is the app's to install. The classic build often found one that another package
 * brought to the top of node_modules, and the Vite build resolves only what the app declares.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "peer-dependencies",
  label: "Declare the peer dependencies of the app's addons that the app does not declare",
  needsInstall: true,

  detect(project) {
    return missingPeers(project).size > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let missing = missingPeers(project);

    editPackageJson(project, (pkg) => {
      for (let [peer, { range }] of missing) setDependency(pkg, peer, range);
    });

    recordProgress(project, {
      id: "peer-dependencies",
      status: "added",
      note:
        "The app declares the peer dependencies that its addons need: " +
        Array.from(
          missing,
          ([peer, { range, addons }]) => `${peer} ${range} (for ${addons.join(", ")})`,
        ).join(", ") +
        ".",
    });

    return [];
  },
};
