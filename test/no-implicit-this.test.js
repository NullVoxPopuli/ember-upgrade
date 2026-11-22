import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { invokables } from "#stages/no-implicit-this/index.js";

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
 * From emberobserver/client, shortened.
 */
test("the codemod skips the components and helpers of the app and its addons", () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: { "ember-power-select": "^9.0.6", "ember-truth-helpers": "^2.1.0" },
    }),
    "app/components/addon-size.js": "",
    "app/components/addon-size.hbs": "",
    "app/components/admin/review/index.js": "",
    "app/helpers/format-bytes.js": "",
    "node_modules/ember-power-select/package.json": JSON.stringify({
      "ember-addon": {
        version: 2,
        "app-js": { "./components/power-select.js": "./dist/_app_/components/power-select.js" },
      },
    }),
    "node_modules/ember-truth-helpers/package.json": "{}",
    "node_modules/ember-truth-helpers/app/helpers/eq.js": "",
  });

  expect(invokables(app)).toMatchInlineSnapshot(`
    [
      "addon-size",
      "admin/review",
      "eq",
      "format-bytes",
      "power-select",
    ]
  `);
});
