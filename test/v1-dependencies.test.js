import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { plannedUpdates } from "#stages/addons/v1-dependencies.js";

/**
 * @param {string} name
 * @param {Record<string, unknown>} manifest
 * @returns {[string, string]}
 */
function installed(name, manifest) {
  return [`node_modules/${name}/package.json`, JSON.stringify(Object.assign({ name }, manifest))];
}

/**
 * From ember-learn/ember-api-docs after the ember-concurrency stage, shortened.
 */
test("ember-basic-dropdown leaves @embroider/util behind, and ember-power-select moves with it", () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));
  let files = Object.fromEntries([
    [
      "package.json",
      JSON.stringify({
        devDependencies: {
          "@ember/test-helpers": "^5.7.0",
          "@glimmer/component": "^2.2.1",
          "ember-basic-dropdown": "^8.11.0",
          "ember-concurrency": "^5.3.0",
          "ember-power-select": "^8.12.1",
        },
      }),
    ],
    installed("@ember/test-helpers", { version: "5.7.0" }),
    installed("@glimmer/component", { version: "2.2.1" }),
    installed("ember-concurrency", { version: "5.3.0", "ember-addon": { version: 2 } }),
    installed("ember-basic-dropdown", {
      version: "8.11.1",
      keywords: ["ember-addon"],
      "ember-addon": { version: 2 },
      dependencies: { "@embroider/util": "^1.13.5" },
    }),
    installed("ember-basic-dropdown/node_modules/@embroider/util", {
      version: "1.13.5",
      keywords: ["ember-addon"],
    }),
    installed("ember-power-select", {
      version: "8.12.1",
      keywords: ["ember-addon"],
      "ember-addon": { version: 2 },
      peerDependencies: { "ember-basic-dropdown": "^8.9.0" },
    }),
  ]);

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  let { updates, blocked } = plannedUpdates(new Project(directory));

  expect(blocked).toEqual([]);
  expect(Array.from(updates.keys()).sort()).toEqual(["ember-basic-dropdown", "ember-power-select"]);
  expect(Number(updates.get("ember-basic-dropdown")?.version.split(".")[0])).toBeGreaterThan(8);
});
