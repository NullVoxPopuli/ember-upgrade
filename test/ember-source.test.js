import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { classicLts, viteLts } from "#stages/ember-source/index.js";
import { renameTitleHelper } from "#stages/ember-source/page-title.js";
import { rewriteWith, useServiceImport } from "#stages/ember-source/removed-apis.js";
import { moveImports } from "#codemods/move-imports.js";

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

/**
 * From code-corps/code-corps-ember (MIT), shortened.
 */
test("the title helper of ember-page-title 3 becomes page-title", () => {
  expect(
    renameTitleHelper(`{{title "Settings"}}
{{~title (concat model.name " Tasks") separator=" | "}}
<h1 title={{title}}>{{title}}</h1>
`),
  ).toMatchInlineSnapshot(`
    "{{page-title "Settings"}}
    {{~page-title (concat model.name " Tasks") separator=" | "}}
    <h1 title={{title}}>{{title}}</h1>
    "
  `);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("with becomes let inside if, and nested ones too", () => {
  expect(
    rewriteWith(`{{#with this.model.addon as |addon|}}
  {{#with addon.latestReview as |review|}}{{review.score}}{{/with}}
{{else}}
  No addon
{{/with}}
`),
  ).toMatchInlineSnapshot(`
    "{{#if this.model.addon}}{{#let this.model.addon as |addon|}}
      {{#if addon.latestReview}}{{#let addon.latestReview as |review|}}{{review.score}}{{/let}}{{/if}}
    {{/let}}{{else}}
      No addon
    {{/if}}
    "
  `);
});

test("htmlSafe moves from @ember/string to @ember/template", () => {
  expect(
    moveImports(
      `import { htmlSafe } from '@ember/string';\n`,
      "app/helpers/dom-purify.js",
      "@ember/string",
      "@ember/template",
      (name) => name === "htmlSafe",
    ),
  ).toBe(`import { htmlSafe } from '@ember/template';\n`);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("inject from @ember/service becomes service, with the same local name", () => {
  expect(
    useServiceImport(
      `import Service, { inject as service } from '@ember/service';
import { inject } from '@ember/service';
`,
      "app/services/search.js",
    ),
  ).toBe(`import Service, { service } from '@ember/service';
import { service as inject } from '@ember/service';
`);
});
