import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import stage from "#stages/addons/test-waiters.js";

/**
 * From ember-learn/guides-source: ember-styleguide 11 comes through guidemaker-ember-template.
 */
test("an addon's ember-test-waiters becomes @ember/test-waiters through an override", async () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));
  let files = {
    "package.json": JSON.stringify({ devDependencies: { "ember-styleguide": "^11.0.3" } }),
    "pnpm-lock.yaml": "",
    "node_modules/ember-styleguide/package.json": JSON.stringify({
      name: "ember-styleguide",
      version: "11.0.3",
      keywords: ["ember-addon"],
      dependencies: { "ember-test-waiters": "^2.1.3" },
    }),
    "node_modules/ember-styleguide/node_modules/ember-test-waiters/package.json": JSON.stringify({
      name: "ember-test-waiters",
      keywords: ["ember-addon"],
    }),
  };

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  let app = new Project(directory);

  expect(stage.detect(app)).toBe(true);

  await stage.run(app);

  expect(app.read("pnpm-workspace.yaml")).toMatch(
    /ember-test-waiters: 'npm:@ember\/test-waiters@\^\d+\.\d+\.\d+'/,
  );
  expect(app.read("pnpm-workspace.yaml")).toMatch(
    /packageExtensions:\n {2}'ember-styleguide@11\.0\.3':\n {4}dependencies:\n {6}ember-auto-import: '\^2\./,
  );
  expect(stage.detect(app)).toBe(false);
});

test("with pnpm 9, the settings go in package.json", async () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));
  let files = {
    "package.json": JSON.stringify({
      packageManager: "pnpm@9.15.0",
      devDependencies: { "ember-styleguide": "^11.0.3" },
    }),
    "pnpm-lock.yaml": "",
    "node_modules/ember-styleguide/package.json": JSON.stringify({
      name: "ember-styleguide",
      version: "11.0.3",
      keywords: ["ember-addon"],
      dependencies: { "ember-test-waiters": "^2.1.3" },
    }),
    "node_modules/ember-styleguide/node_modules/ember-test-waiters/package.json": JSON.stringify({
      name: "ember-test-waiters",
      keywords: ["ember-addon"],
    }),
  };

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  let app = new Project(directory);

  expect(stage.detect(app)).toBe(true);

  await stage.run(app);

  let { pnpm } = JSON.parse(app.read("package.json"));

  expect(app.has("pnpm-workspace.yaml")).toBe(false);
  expect(pnpm.overrides["ember-test-waiters"]).toMatch(/^npm:@ember\/test-waiters@\^/);
  expect(
    pnpm.packageExtensions["ember-styleguide@11.0.3"].dependencies["ember-auto-import"],
  ).toMatch(/^\^2\./);
  expect(stage.detect(app)).toBe(false);
});
