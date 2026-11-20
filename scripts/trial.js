/**
 * Upgrades one real app with the built CLI, and compares the result with trials/apps.js.
 *
 *   node scripts/trial.js <name> [--keep]
 *
 * The app is cloned into a temporary folder. --keep prints the folder and leaves it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { toTree } from "ember-estree";
import { apps } from "../trials/apps.js";

let { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { keep: { type: "boolean", default: false } },
});

let app = apps.find((a) => a.name === positionals[0]);

if (!app) {
  console.error(`Usage: node scripts/trial.js <${apps.map((a) => a.name).join("|")}>`);
  process.exit(1);
}

const cli = resolve("dist/cli.js");
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "ember-upgrade",
  GIT_AUTHOR_EMAIL: "ember-upgrade@example.com",
  GIT_COMMITTER_NAME: "ember-upgrade",
  GIT_COMMITTER_EMAIL: "ember-upgrade@example.com",
  CI: "true",
};

/**
 * @param {string} cwd
 * @param {string} command
 * @param {string[]} args
 * @param {{ capture?: boolean }} [options]
 */
function sh(cwd, command, args, options = {}) {
  let result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: process.platform === "win32",
  });

  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

let root = mkdtempSync(join(tmpdir(), `trial-${app.name}-`));
let checkout = join(root, "repo");
let project = app.directory ? join(checkout, app.directory) : checkout;
/** @type {string[]} */
let failures = [];

try {
  sh(root, "git", ["init", "-q", checkout]);

  if (
    !sh(checkout, "git", [
      "fetch",
      "-q",
      "--depth",
      "1",
      `https://github.com/${app.repo}.git`,
      app.sha,
    ]).ok
  ) {
    throw new Error(`Cannot fetch ${app.repo}@${app.sha}`);
  }

  sh(checkout, "git", ["checkout", "-q", "FETCH_HEAD"]);

  for (let command of app.setup ?? []) {
    if (!sh(project, command[0], command.slice(1)).ok) {
      throw new Error(`Setup \`${command.join(" ")}\` failed`);
    }
  }

  console.log(`\n== ${app.name}: ember-upgrade ${project}\n`);

  let args = app.verify ? [cli, project, "--verify"] : [cli, project];
  let run = sh(project, process.execPath, args, { capture: true });
  let output = run.stdout + run.stderr;

  console.log(output);

  let log = sh(checkout, "git", ["log", "--format=%s", `${app.sha}..HEAD`], { capture: true });
  let completed = log.stdout
    .split("\n")
    .filter((line) => line.startsWith("ember-upgrade: "))
    .map((line) => line.slice("ember-upgrade: ".length))
    .reverse();

  if (completed.join(",") !== app.completed.join(",")) {
    failures.push(
      `Completed stages: [${completed.join(", ")}]. trials/apps.js expects [${app.completed.join(", ")}].`,
    );
  }

  let stop = output.split("\n").find((line) => line.startsWith("x "));

  if (app.stopsAt) {
    let { stage, message } = app.stopsAt;

    if (!stop?.startsWith(`x ${stage}:`) || !output.includes(message)) {
      failures.push(`Expected a stop at "${stage}" with "${message}". Got: ${stop ?? "no stop"}`);
    }
  } else if (stop) {
    failures.push(`Unexpected stop: ${stop}`);
  }

  let changed = sh(checkout, "git", ["diff", "--name-only", app.sha, "HEAD"], { capture: true });

  for (let file of changed.stdout.split("\n")) {
    if (!/\.(js|ts|gjs|gts)$/.test(file)) continue;

    let source;

    try {
      source = readFileSync(join(checkout, file), "utf8");
    } catch {
      continue;
    }

    let tree = /** @type {{ errors?: { message: string }[] }} */ (
      toTree(source, { filePath: file })
    );

    if (tree.errors?.length) failures.push(`${file} does not parse: ${tree.errors[0].message}`);
  }

  if (failures.length === 0 && !app.stopsAt) {
    for (let command of app.after ?? []) {
      if (!sh(project, command[0], command.slice(1)).ok) {
        failures.push(`\`${command.join(" ")}\` failed`);
        break;
      }
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  if (values.keep) console.log(`\nKept ${checkout}`);
  else rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n== ${app.name}: FAILED\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}

console.log(`\n== ${app.name}: as expected`);
