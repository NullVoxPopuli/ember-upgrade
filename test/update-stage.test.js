import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { updateStage } from "#stages/addons/updates.js";

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
 * From emberobserver/client, after the vite stage, shortened.
 */
test("an update moves older pins of what the release needs to its ranges, and declares its peers", async () => {
  let app = project({
    "yarn.lock": "",
    "package.json": JSON.stringify({
      devDependencies: { "ember-concurrency": "^5.3.0", "ember-power-select": "^4.1.3" },
      resolutions: {
        "ember-basic-dropdown": "3.0.16",
        "ember-element-helper": "^1.0.0",
      },
    }),
  });

  let stage = updateStage("ember-power-select", {
    version: "9.0.6",
    addon: true,
    v2: true,
    repository: undefined,
    dependencies: { "ember-element-helper": "^0.8.8", "ember-modifier": "^4.3.0" },
    peerDependencies: {
      "ember-basic-dropdown": "^9.0.1",
      "ember-concurrency": "^5.3.0",
      "ember-source": ">= 4.12.0",
    },
  });

  expect(stage.detect(app)).toBe(true);

  await stage.run(app);

  let { devDependencies, resolutions } = JSON.parse(app.read("package.json"));

  expect({ devDependencies, resolutions }).toMatchInlineSnapshot(`
    {
      "devDependencies": {
        "ember-basic-dropdown": "^9.0.1",
        "ember-concurrency": "^5.3.0",
        "ember-power-select": "^9.0.6",
      },
      "resolutions": {
        "ember-basic-dropdown": "^9.0.1",
        "ember-element-helper": "^1.0.0",
      },
    }
  `);
  expect(app.read("ember-upgrade-progress.yaml")).toContain(
    "ember-basic-dropdown (3.0.16, and ember-power-select 9.0.6 asks for ^9.0.1)",
  );
  expect(stage.detect(app)).toBe(false);
});
