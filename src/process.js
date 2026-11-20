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

  /**
   * The stages change package.json, so the install must update the lockfile.
   * pnpm and yarn freeze the lockfile when CI is set.
   */
  if (pm === "pnpm") return exec(project, pm, ["install", "--no-frozen-lockfile"]);
  if (pm === "yarn") process.env.YARN_ENABLE_IMMUTABLE_INSTALLS = "false";

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

/**
 * @typedef {object} Published
 * @property {string} version the `latest` version
 * @property {boolean} addon the latest version is an ember addon
 * @property {boolean} v2 the latest version is a v2 addon, or a plain package
 * @property {string | undefined} repository a URL for people to read
 */

/**
 * Reads the latest published version of a package from the registry.
 *
 * @param {string} name
 * @returns {Published | undefined} undefined when the registry does not have it
 */
export function published(name) {
  let result = spawnSync(
    "npm",
    ["view", name, "version", "keywords", "ember-addon", "repository", "--json"],
    {
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );

  if (result.status !== 0 || !result.stdout.trim()) return;

  let info = JSON.parse(result.stdout);
  let addon = Boolean(info.keywords?.includes("ember-addon") || info["ember-addon"]);

  let url = typeof info.repository === "string" ? info.repository : info.repository?.url;
  let repository = url
    ?.replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");

  return {
    version: info.version,
    addon,
    v2: !addon || info["ember-addon"]?.version === 2,
    repository,
  };
}
