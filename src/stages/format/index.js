import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { exec } from "#process.js";

/** @typedef {import('#project.js').Project} Project */

const PRETTIER_CONFIG = /^(\.prettierrc(\.\w+)?|prettier\.config\.\w+)$/;

/**
 * @param {Project} project
 * @param {string[]} args
 */
function git(project, args) {
  return spawnSync("git", args, { cwd: project.directory, encoding: "utf8" });
}

/**
 * @param {Project} project
 * @returns {boolean} the app formats with Prettier, and its own config
 */
function hasPrettier(project) {
  if (!project.dependency("prettier")) return false;
  if (project.packageJson.prettier) return true;

  return project
    .files([".prettierrc*", "prettier.config.*"])
    .some((file) => PRETTIER_CONFIG.test(file));
}

/**
 * The files that the upgrade changed: those since the commit before the first stage commit, and the new ones.
 *
 * @param {Project} project
 * @returns {string[]}
 */
export function changedFiles(project) {
  let log = git(project, ["log", "--format=%H %s"]);

  if (log.status !== 0) return [];

  let stages = log.stdout
    .split("\n")
    .filter((line) => line.slice(41).startsWith("ember-upgrade: "));
  let first = stages[stages.length - 1]?.slice(0, 40);
  let base = first ? `${first}~1` : "HEAD";
  let changed = git(project, ["diff", "--name-only", "--diff-filter=d", base]).stdout;
  let added = git(project, ["ls-files", "--others", "--exclude-standard"]).stdout;

  return Array.from(new Set(changed.split("\n").concat(added.split("\n"))))
    .filter((file) => file && existsSync(join(project.directory, file)))
    .sort();
}

/**
 * @param {Project} project
 * @returns {string[]} the changed files that Prettier formats differently
 */
function unformatted(project) {
  let files = changedFiles(project);

  if (files.length === 0) return [];

  let result = spawnSync(
    "npx",
    ["prettier", "--list-different", "--ignore-unknown", "--no-error-on-unmatched-pattern"].concat(
      files,
    ),
    { cwd: project.directory, encoding: "utf8" },
  );

  /**
   * Without its config, Prettier would format in its default style, so the stage stops.
   */
  if (/Invalid configuration/.test(result.stderr)) {
    throw new Error(`Prettier cannot load the app's config:\n${result.stderr}`);
  }

  return result.stdout.split("\n").filter(Boolean);
}

/**
 * The stages write code in their own style. The app's Prettier config gives it the app's style.
 * Only the files that the upgrade changed are formatted, so that the diff holds only the upgrade.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "format",
  label: "Format the changed files with the app's Prettier config",
  needsInstall: true,

  detect(project) {
    return hasPrettier(project) && unformatted(project).length > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let files = unformatted(project);

    exec(project, "npx", ["prettier", "--write", "--ignore-unknown"].concat(files));

    return [];
  },
};
