import { spawnSync } from "node:child_process";

/**
 * @param {import('#project.js').Project} project
 * @returns {"pnpm" | "yarn" | "npm"}
 */
export function packageManager(project) {
  if (project.has("pnpm-lock.yaml")) return "pnpm";
  if (project.has("yarn.lock")) return "yarn";

  return "npm";
}

/**
 * Runs a command in the project, with its output on the terminal.
 *
 * @param {import('#project.js').Project} project
 * @param {string} command
 * @param {string[]} args
 * @returns {boolean} true when the command exits with 0
 */
export function exec(project, command, args) {
  let result = spawnSync(command, args, {
    cwd: project.directory,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  return result.status === 0;
}

/**
 * @param {import('#project.js').Project} project
 */
export function install(project) {
  let pm = packageManager(project);

  return exec(project, pm, ["install"]);
}

/**
 * Runs an upstream codemod at a fixed version, with the project's package manager.
 *
 * Each stage that calls this is a stage to port to ember-estree,
 * so that the bundle needs nothing from the network.
 *
 * @param {import('#project.js').Project} project
 * @param {string} spec for example "ember-vite-codemod@1.9.0"
 * @param {string[]} args
 */
export function runUpstream(project, spec, args) {
  let pm = packageManager(project);

  if (pm === "pnpm") return exec(project, "pnpm", ["dlx", spec].concat(args));
  if (pm === "yarn") return exec(project, "yarn", ["dlx", spec].concat(args));

  return exec(project, "npx", ["--yes", spec].concat(args));
}
