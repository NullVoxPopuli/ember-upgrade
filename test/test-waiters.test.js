import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { replaceTestWaiters } from "#stages/addons/test-waiters.js";

/**
 * From ember-learn/guides-source: ember-styleguide 11 comes through guidemaker-ember-template.
 */
test("an addon's ember-test-waiters becomes @ember/test-waiters through an override", () => {
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

  expect(replaceTestWaiters(app)).toBe(true);
  expect(app.read("pnpm-workspace.yaml")).toMatch(
    /ember-test-waiters: 'npm:@ember\/test-waiters@\^\d+\.\d+\.\d+'/,
  );
  expect(replaceTestWaiters(app)).toBe(false);
});
