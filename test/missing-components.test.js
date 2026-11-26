import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { templateNames } from "#stages/dynamic-components/names.js";
import { removeMissingCalls } from "#stages/missing-components/index.js";

/**
 * @param {Record<string, string | object>} files
 */
function project(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(
      join(directory, file),
      typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
    );
  }

  return new Project(directory);
}

/**
 * From documize/community gui/app/templates, shortened.
 * No version of the app has layout/master-sidebar or folder/settings-templates.
 */
test("calls to components and helpers that do not exist are removed", () => {
  let template = `{{#layout/master-sidebar}}
	one<br>
{{/layout/master-sidebar}}
{{#layout/master-content}}
	{{#if (eq this.tab "templates")}}
		{{folder/settings-templates space=this.model.folder}}
	{{/if}}
	{{#each-in this.groups as |key group-item|}}
		{{group-item}} {{format-date key}} {{this.page-title}} {{@on-click}}
	{{/each-in}}
	{{#link-to "folder"}}x{{/link-to}}
{{/layout/master-content}}
`;
  let names = {
    components: new Set(["layout/master-content"]),
    helpers: new Set(["format-date"]),
  };

  expect(removeMissingCalls(template, names)).toMatchInlineSnapshot(`
    {
      "output": "
    {{#layout/master-content}}
    	{{#if (eq this.tab "templates")}}
    	{{/if}}
    	{{#each-in this.groups as |key group-item|}}
    		{{group-item}} {{format-date key}} {{this.page-title}} {{@on-click}}
    	{{/each-in}}
    	{{#link-to "folder"}}x{{/link-to}}
    {{/layout/master-content}}
    ",
      "removed": [
        "layout/master-sidebar",
        "folder/settings-templates",
      ],
    }
  `);
});

test("the names come from the app, its in-repo addons, and the app trees of its addons", () => {
  let app = project({
    "package.json": { name: "app", dependencies: { "v1-addon": "1.0.0", "v2-addon": "1.0.0" } },
    "app/components/layout/master-content.hbs": "",
    "app/components/ui/button/index.js": "",
    "app/templates/components/old-style.hbs": "",
    "app/helpers/format-date.js": "",
    "lib/in-repo/package.json": { name: "in-repo", keywords: ["ember-addon"] },
    "lib/in-repo/app/components/from-lib.js": "",
    "node_modules/v1-addon/package.json": { name: "v1-addon", keywords: ["ember-addon"] },
    "node_modules/v1-addon/app/components/x-select/component.js": "",
    "node_modules/v1-addon/app/helpers/v1-helper.js": "",
    "node_modules/v2-addon/package.json": {
      name: "v2-addon",
      keywords: ["ember-addon"],
      "ember-addon": {
        version: 2,
        "app-js": {
          "./components/v2-thing.js": "./dist/_app_/components/v2-thing.js",
          "./helpers/v2-helper.js": "./dist/_app_/helpers/v2-helper.js",
          "./services/v2-service.js": "./dist/_app_/services/v2-service.js",
        },
      },
    },
  });

  let names = templateNames(app);

  expect({
    components: Array.from(names?.components ?? []).sort(),
    helpers: Array.from(names?.helpers ?? []).sort(),
  }).toMatchInlineSnapshot(`
    {
      "components": [
        "from-lib",
        "layout/master-content",
        "old-style",
        "ui/button",
        "v2-thing",
        "x-select",
      ],
      "helpers": [
        "format-date",
        "v1-helper",
        "v2-helper",
      ],
    }
  `);
});

test("no names when a dependency is not installed, because its addon can add names", () => {
  let app = project({
    "package.json": { name: "app", dependencies: { "not-installed": "1.0.0" } },
  });

  expect(templateNames(app)).toBeUndefined();
});
