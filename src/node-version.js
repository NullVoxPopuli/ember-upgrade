/** @typedef {import('#project.js').Project} Project */

/**
 * The Node.js LTS line that the upgraded app runs on.
 */
export const NODE_LTS = "24";

/**
 * The ember.nvp build tooling calls `RegExp.escape`, which Node.js has from 24 on.
 */
export const NODE_MINIMUM = 24;

/**
 * @param {string} version such as `20.20.2` or `v22`
 * @returns {boolean}
 */
function tooOld(version) {
  let major = Number(/^\s*v?(\d+)/.exec(version)?.[1]);

  return Number.isFinite(major) && major < NODE_MINIMUM;
}

/**
 * Moves the Node.js versions that the project pins to the LTS line, when they are older than the build tooling needs.
 * pnpm runs scripts with the `use-node-version` of .npmrc, and version managers read .nvmrc and .node-version.
 *
 * @param {Project} project
 * @returns {string[]} the files that changed
 */
export function updateNodePins(project) {
  /** @type {string[]} */
  let changed = [];

  if (project.has(".npmrc")) {
    let source = project.read(".npmrc");
    let output = source.replace(/^(\s*use-node-version\s*=\s*)(\S+)/m, (all, key, version) =>
      tooOld(version) ? `${key}${NODE_LTS}` : all,
    );

    if (output !== source) {
      project.write(".npmrc", output);
      changed.push(".npmrc");
    }
  }

  for (let file of [".nvmrc", ".node-version"]) {
    if (!project.has(file)) continue;

    let source = project.read(file);

    if (tooOld(source)) {
      project.write(file, `${NODE_LTS}\n`);
      changed.push(file);
    }
  }

  return changed;
}
