import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import {
  addonComponents,
  replaceShims,
  writeShims,
} from "#stages/template-tag/addon-components.js";

/**
 * @param {Record<string, string | object>} files
 */
function project(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(
      join(directory, file),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }

  return new Project(directory);
}

const VC = "node_modules/@html-next/vertical-collection";

/**
 * From TryGhost/Ghost ghost/admin, shortened, after the update to @html-next/vertical-collection 6.0.0,
 * which has an empty `app-js` and exports the component from its entry.
 */
test("a template's call of a v2 addon's component becomes a named import of the addon", () => {
  let app = project({
    "package.json": {
      name: "ghost-admin",
      devDependencies: { "@html-next/vertical-collection": "^6.0.0" },
    },
    [`${VC}/package.json`]: {
      name: "@html-next/vertical-collection",
      version: "6.0.0",
      keywords: ["ember-addon"],
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      "ember-addon": { version: 2, type: "addon", main: "addon-main.cjs", "app-js": {} },
    },
    [`${VC}/dist/index.js`]: "export { VerticalCollection };\n",
    "app/components/gh-member-list.hbs": `{{#vertical-collection @members estimateHeight=60 as |member|}}
  <GhMember @member={{member}} />
{{/vertical-collection}}
`,
  });

  let components = addonComponents(app);

  expect(components).toMatchInlineSnapshot(`
    [
      {
        "call": "vertical-collection",
        "exported": "VerticalCollection",
        "from": "@html-next/vertical-collection",
      },
    ]
  `);

  writeShims(app, components);

  expect(app.read("app/components/vertical-collection.js")).toMatchInlineSnapshot(`
    "export { VerticalCollection as default } from "@html-next/vertical-collection";
    "
  `);

  /**
   * What the template-tag codemod writes for the component, and for a route template.
   */
  app.write(
    "app/components/gh-member-list.gjs",
    `import VerticalCollection from "./vertical-collection.js";\n<template>{{#VerticalCollection}}{{/VerticalCollection}}</template>\n`,
  );
  app.write(
    "app/templates/members.gjs",
    `import VerticalCollection0 from "ghost-admin/components/vertical-collection";\n<template>{{#VerticalCollection0}}{{/VerticalCollection0}}</template>\n`,
  );

  replaceShims(app, components);

  expect(app.read("app/components/gh-member-list.gjs")).toMatchInlineSnapshot(`
    "import { VerticalCollection } from "@html-next/vertical-collection";
    <template>{{#VerticalCollection}}{{/VerticalCollection}}</template>
    "
  `);
  expect(app.read("app/templates/members.gjs")).toMatchInlineSnapshot(`
    "import { VerticalCollection as VerticalCollection0 } from "@html-next/vertical-collection";
    <template>{{#VerticalCollection0}}{{/VerticalCollection0}}</template>
    "
  `);
  expect(existsSync(join(app.directory, "app/components/vertical-collection.js"))).toBe(false);
});
