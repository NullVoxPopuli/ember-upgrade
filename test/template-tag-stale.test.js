import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { removeStaleTemplates } from "#stages/template-tag/stale-templates.js";

/**
 * From hashicorp-forge/hermes (MPL-2.0) web/app/components/results/, shortened.
 */
test("an .hbs file next to a .gts component with its own template goes", () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));
  let files = {
    "app/components/results/section-header.gts": "<template><h4>{{@text}}</h4></template>\n",
    "app/components/results/section-header.hbs": "<h4>{{@text}}</h4>\n",
    "app/components/results/list.js": "export default class {}\n",
    "app/components/results/list.hbs": "<ul></ul>\n",
  };

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  let app = new Project(directory);

  expect(removeStaleTemplates(app)).toEqual(["app/components/results/section-header.hbs"]);
  expect(app.has("app/components/results/list.hbs")).toBe(true);
});
