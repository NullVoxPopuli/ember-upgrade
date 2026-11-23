import { spawnSync } from "node:child_process";
import { releaseAge } from "#manager-settings.js";
import { exec, install, packageManager, setMinimumReleaseAge } from "#process.js";

/** @typedef {import('#types.js').Finding} Finding */
/** @typedef {import('#types.js').Stage} Stage */
/** @typedef {import('#types.js').StageGroup} StageGroup */

/**
 * @typedef {object} RunOptions
 * @property {boolean} [check] report only, and change nothing
 * @property {boolean} [commit] commit after each stage (default true)
 * @property {boolean} [verify] install and build after each stage
 * @property {(line: string) => void} [log]
 */

/**
 * @param {string} heading
 * @param {Finding[]} findings
 * @returns {string}
 */
export function formatFindings(heading, findings) {
  let lines = [heading];

  for (let finding of findings) {
    lines.push(`  - ${finding.title}`);

    for (let where of finding.where ?? []) lines.push(`      ${where}`);

    if (finding.action) lines.push(`    ${finding.action}`);
  }

  return lines.join("\n");
}

/**
 * @param {import('#project.js').Project} project
 * @param {string[]} args
 */
function git(project, args) {
  return spawnSync("git", args, { cwd: project.directory, encoding: "utf8" });
}

/**
 * Each commit names the maintainer of ember-upgrade as a co-author,
 * so that the history of an upgraded app shows where the change came from.
 */
export const CO_AUTHOR =
  "Co-Authored-By: NullVoxPopuli <199018+NullVoxPopuli@users.noreply.github.com>";

/**
 * @param {Stage} stage
 */
export function commitMessage(stage) {
  return `ember-upgrade: ${stage.name}\n\n${stage.label}\n\n${CO_AUTHOR}`;
}

/**
 * Runs each stage that the project still needs, in order.
 *
 * Stops at the first stage with blockers, or the first stage that fails.
 * Each stage gets its own commit, so a later failure leaves the earlier stages in place.
 *
 * @param {import('#project.js').Project} project
 * @param {(Stage | StageGroup)[]} stages
 * @param {RunOptions} [options]
 * @returns {Promise<{ ok: boolean, todo: Finding[] }>}
 */
export async function run(project, stages, options = {}) {
  let log = options.log ?? console.log;
  let commit = options.commit ?? true;
  /** @type {Finding[]} */
  let todo = [];

  if (!options.check && commit) {
    let status = git(project, ["status", "--porcelain"]);

    if (status.status !== 0) {
      log("The project is not a git repository. Run `git init` and commit, or pass --no-commit.");
      return { ok: false, todo };
    }

    if (status.stdout.trim() !== "") {
      log("The git working tree has changes. Commit or stash them first.");
      return { ok: false, todo };
    }
  }

  let result = await runStages(project, stages, { log, commit, options, todo });

  if (result === "stop") return { ok: false, todo };
  if (result === "checked") return { ok: true, todo };

  if (todo.length > 0) log(formatFindings("Left for you:", todo));

  return { ok: true, todo };
}

/**
 * @typedef {object} Context
 * @property {(line: string) => void} log
 * @property {boolean} commit
 * @property {RunOptions} options
 * @property {Finding[]} todo
 */

/**
 * @param {import('#project.js').Project} project
 * @param {(Stage | StageGroup)[]} stages
 * @param {Context} context
 * @returns {Promise<"done" | "stop" | "checked">}
 */
async function runStages(project, stages, context) {
  let { log } = context;

  for (let stage of stages) {
    if ("expand" in stage) {
      if (context.options.check) {
        log(`> ${stage.name}: ${stage.label}`);
        return "checked";
      }

      if (stage.needsInstall && !install(project)) {
        log(`x ${stage.name}: \`${packageManager(project)} install\` failed`);
        return "stop";
      }

      let children = await stage.expand(project);

      if (children.length === 0) {
        log(`- ${stage.name}: nothing to do`);
        continue;
      }

      let result = await runStages(project, children, context);

      if (result !== "done") return result;

      continue;
    }

    let result = await runStage(project, stage, context);

    if (result !== "done") return result;
  }

  return "done";
}

/**
 * @param {import('#project.js').Project} project
 * @param {Stage} stage
 * @param {Context} context
 * @returns {Promise<"done" | "stop" | "checked">}
 */
async function runStage(project, stage, { log, commit, options, todo }) {
  setMinimumReleaseAge(releaseAge(project));

  if (!stage.detect(project)) {
    log(`- ${stage.name}: nothing to do`);
    return "done";
  }

  let report = await stage.check(project);

  if (report.blockers.length > 0) {
    log(formatFindings(`x ${stage.name}: blocked`, report.blockers));
    return "stop";
  }

  if (options.check) {
    log(`> ${stage.name}: ${stage.label}`);

    if (report.todo.length > 0) log(formatFindings("  leaves for you:", report.todo));

    for (let item of report.todo) todo.push(item);

    /**
     * The stages after this one see the project before this stage runs.
     * Their reports are not reliable, so stop.
     */
    return "checked";
  }

  log(`> ${stage.name}: ${stage.label}`);

  if (stage.needsInstall && !install(project)) {
    log(`x ${stage.name}: \`${packageManager(project)} install\` failed`);
    return "stop";
  }

  try {
    for (let item of await stage.run(project)) todo.push(item);
  } catch (error) {
    log(`x ${stage.name}: ${error instanceof Error ? error.message : String(error)}`);
    return "stop";
  }

  /**
   * Some upstream codemods stop at their own checks and still exit with 0.
   */
  if (stage.detect(project)) {
    log(`x ${stage.name}: the stage did not finish. Its output is above.`);
    return "stop";
  }

  if (options.verify) {
    let pm = packageManager(project);

    if (!install(project) || !exec(project, pm, ["run", "build"])) {
      log(`x ${stage.name}: the build fails after this stage`);
      return "stop";
    }
  }

  if (commit) {
    git(project, ["add", "-A"]);

    let result = git(project, ["commit", "-m", commitMessage(stage)]);

    if (result.status !== 0) {
      log(`x ${stage.name}: git commit failed\n${result.stderr}`);
      return "stop";
    }
  }

  log(`✓ ${stage.name}`);

  return "done";
}
