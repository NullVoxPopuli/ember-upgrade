import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { classicLts, viteLts } from "#stages/ember-source/index.js";

/**
 * @param {Record<string, unknown>} pkg
 */
function project(pkg) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  writeFileSync(join(directory, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  return new Project(directory);
}

/**
 * The versions in TryGhost/Ghost ghost/admin at 6c43413, shortened.
 */
const GHOST = {
  name: "ghost-admin",
  devDependencies: {
    "ember-cli": "~4.12.3",
    "ember-data": "3.24.0",
    "ember-qunit": "5.1.5",
    "ember-resolver": "8.0.3",
    "ember-source": "3.24.0",
    "ember-auto-import": "catalog:",
    "@tryghost/kg-clean-basic-html": "workspace:*",
  },
};

test("one stage for each LTS above the app's version, with 7.x after the vite stage", async () => {
  let app = project(GHOST);
  let stages = (await classicLts.expand(app)).concat(await viteLts.expand(app));

  expect(stages.map((stage) => stage.name)).toEqual([
    "ember-source-3.28",
    "ember-source-4.4",
    "ember-source-4.8",
    "ember-source-4.12",
    "ember-source-5.4",
    "ember-source-5.8",
    "ember-source-5.12",
    "ember-source-6.4",
    "ember-source-6.8",
    "ember-source-6.12",
    "ember-source-7.4",
  ]);
});

test("a step updates the blueprint packages that the app has, and only up, so exact pins at the same version stay", async () => {
  let app = project(GHOST);
  let [first] = await classicLts.expand(app);

  await first.run(app);

  expect(first.detect(app)).toBe(false);
  expect(app.packageJson.devDependencies).toEqual({
    "ember-cli": "~4.12.3",
    "ember-data": "~3.28.6",
    "ember-qunit": "5.1.5",
    "ember-resolver": "8.0.3",
    "ember-source": "~3.28.12",
    "ember-auto-import": "catalog:",
    "@tryghost/kg-clean-basic-html": "workspace:*",
  });
});

test("an app on an LTS gets no step for it", async () => {
  let app = project({ devDependencies: { "ember-source": "~6.12.0" } });

  expect(await classicLts.expand(app)).toEqual([]);
  expect((await viteLts.expand(app)).map((stage) => stage.name)).toEqual(["ember-source-7.4"]);
});
