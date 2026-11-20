import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Project } from "#project.js";
import { run } from "#runner.js";
import emberGlobals from "#stages/ember-globals/index.js";

/**
 * @param {Record<string, string>} files
 */
function gitProject(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  let git = (/** @type {string[]} */ ...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" });

  git("init", "-q");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "add", "-A");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "init");

  return { directory, git };
}

test("each stage is one commit, and a second run does nothing", async () => {
  let { directory, git } = gitProject({
    "package.json": `{ "name": "x" }`,
    "app/app.js": `import Ember from 'ember';\nexport default Ember.Application.extend();\n`,
  });
  let project = new Project(directory);
  /** @type {string[]} */
  let lines = [];
  let log = (/** @type {string} */ line) => lines.push(line);

  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com";

  expect(await run(project, [emberGlobals], { log })).toMatchObject({ ok: true, todo: [] });
  expect(readFileSync(join(directory, "app/app.js"), "utf8")).toBe(
    `import Application from '@ember/application';\nexport default Application.extend();\n`,
  );
  expect(git("log", "--format=%s").trim().split("\n")).toEqual([
    "ember-upgrade: ember-globals",
    "init",
  ]);

  lines.length = 0;
  await run(project, [emberGlobals], { log });
  expect(lines).toEqual(["- ember-globals: nothing to do"]);
});

test("a dirty working tree stops the run", async () => {
  let { directory } = gitProject({ "package.json": `{ "name": "x" }` });

  writeFileSync(join(directory, "new.js"), "");

  /** @type {string[]} */
  let lines = [];
  let result = await run(new Project(directory), [emberGlobals], {
    log: (line) => lines.push(line),
  });

  expect(result.ok).toBe(false);
  expect(lines).toEqual(["The git working tree has changes. Commit or stash them first."]);
});

test("a stage that exits but changes nothing stops the run", async () => {
  let { directory } = gitProject({ "package.json": `{ "name": "x" }` });
  /** @type {string[]} */
  let lines = [];
  /** @type {import('#types.js').Stage} */
  let stuck = {
    name: "stuck",
    label: "Never finishes",
    detect: () => true,
    check: async () => ({ blockers: [], todo: [] }),
    run: async () => [],
  };

  let result = await run(new Project(directory), [stuck], { log: (line) => lines.push(line) });

  expect(result.ok).toBe(false);
  expect(lines).toEqual([
    "> stuck: Never finishes",
    "x stuck: the stage did not finish. Its output is above.",
  ]);
});
