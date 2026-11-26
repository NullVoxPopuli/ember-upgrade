import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import emberCliApp from "#stages/ember-cli-app/index.js";

/**
 * @param {Record<string, string>} files
 */
function project(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  return new Project(directory);
}

/**
 * From streamlink/streamlink-twitch-gui (MIT), which builds Ember with webpack from src/app.
 */
test("a project that builds Ember with webpack stops", async () => {
  let app = project({
    "package.json": JSON.stringify({
      name: "streamlink-twitch-gui",
      devDependencies: { "ember-source": "3.7.0" },
    }),
    "build/tasks/configs/webpack.js": "module.exports = {};\n",
    "src/app/app.js": "export default {};\n",
  });

  expect(emberCliApp.detect(app)).toBe(true);
  expect((await emberCliApp.check(app)).blockers.map((blocker) => blocker.title)).toEqual([
    "The project has no ember-cli-build.js, Vite config, or app/ folder",
  ]);
});

test("ember-cli apps and v2 addons go on", () => {
  expect(
    emberCliApp.detect(
      project({ "package.json": "{}", "ember-cli-build.js": "", "app/app.js": "" }),
    ),
  ).toBe(false);
  expect(emberCliApp.detect(project({ "package.json": "{}", "vite.config.mjs": "" }))).toBe(false);
  expect(
    emberCliApp.detect(
      project({
        "package.json": JSON.stringify({ "ember-addon": { version: 2 } }),
        "src/index.js": "",
      }),
    ),
  ).toBe(false);
});
