import { spawnSync } from "node:child_process";
import { exec, install, packageManager } from "#process.js";

/** @typedef {import('#types.js').Finding} Finding */
/** @typedef {import('#types.js').Stage} Stage */

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
 * Runs each stage that the project still needs, in order.
 *
 * Stops at the first stage with blockers, or the first stage that fails.
 * Each stage gets its own commit, so a later failure leaves the earlier stages in place.
 *
 * @param {import('#project.js').Project} project
 * @param {Stage[]} stages
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

  for (let stage of stages) {
    if (!stage.detect(project)) {
      log(`- ${stage.name}: nothing to do`);
      continue;
    }

    let report = await stage.check(project);

    if (report.blockers.length > 0) {
      log(formatFindings(`x ${stage.name}: blocked`, report.blockers));
      return { ok: false, todo };
    }

    if (options.check) {
      log(`> ${stage.name}: ${stage.label}`);

      if (report.todo.length > 0) log(formatFindings("  leaves for you:", report.todo));

      /**
       * The stages after this one see the project before this stage runs.
       * Their reports are not reliable, so stop.
       */
      return { ok: true, todo: report.todo };
    }

    log(`> ${stage.name}: ${stage.label}`);

    if (stage.needsInstall && !install(project)) {
      log(`x ${stage.name}: \`${packageManager(project)} install\` failed`);
      return { ok: false, todo };
    }

    try {
      for (let item of await stage.run(project)) todo.push(item);
    } catch (error) {
      log(`x ${stage.name}: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, todo };
    }

    /**
     * Some upstream codemods stop at their own checks and still exit with 0.
     */
    if (stage.detect(project)) {
      log(`x ${stage.name}: the stage did not finish. Its output is above.`);
      return { ok: false, todo };
    }

    if (options.verify) {
      let pm = packageManager(project);

      if (!install(project) || !exec(project, pm, ["run", "build"])) {
        log(`x ${stage.name}: the build fails after this stage`);
        return { ok: false, todo };
      }
    }

    if (commit) {
      git(project, ["add", "-A"]);

      let result = git(project, ["commit", "-m", `ember-upgrade: ${stage.name}\n\n${stage.label}`]);

      if (result.status !== 0) {
        log(`x ${stage.name}: git commit failed\n${result.stderr}`);
        return { ok: false, todo };
      }
    }

    log(`✓ ${stage.name}`);
  }

  if (todo.length > 0) log(formatFindings("Left for you:", todo));

  return { ok: true, todo };
}
