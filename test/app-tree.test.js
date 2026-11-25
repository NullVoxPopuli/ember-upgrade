import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import appTree, { calledByName } from "#stages/app-tree/index.js";
import declareImports from "#stages/declare-imports/index.js";

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

/**
 * From rust-lang/crates.io: ember-data and ember-cli-notifications, shortened.
 */
function cratesIo() {
  return project({
    "package.json": {
      name: "crates-io",
      devDependencies: { "ember-data": "~5.8.2", "ember-cli-notifications": "9.1.0" },
    },
    "app/services/store.js": "export { default } from 'ember-data/store';\n",
    "app/models/crate.js": "import Model, { attr } from '@ember-data/model';\n",
    "node_modules/ember-data/package.json": {
      name: "ember-data",
      version: "5.8.2",
      keywords: ["ember-addon"],
      exports: { "./app/*": { default: "./app/*.js" }, "./*": { default: "./dist/*.js" } },
      dependencies: { "@ember-data/model": "5.8.2" },
      "ember-addon": {
        version: 2,
        "app-js": {
          "./initializers/ember-data.js": "./app/initializers/ember-data.js",
          "./services/store.js": "./app/services/store.js",
        },
      },
    },
    /**
     * Hoisting reaches a newer copy than the one that ember-data asks for.
     */
    "node_modules/.pnpm/node_modules/@ember-data/model/package.json": {
      name: "@ember-data/model",
      version: "5.9.1",
    },
    "node_modules/ember-cli-notifications/package.json": {
      name: "ember-cli-notifications",
      version: "9.1.0",
      keywords: ["ember-addon"],
      exports: { "./*": "./dist/*.js" },
      "ember-addon": {
        version: 2,
        "app-js": {
          "./components/notification-message.js": "./dist/_app_/components/notification-message.js",
        },
      },
    },
    /**
     * The container's template is loose mode, so it finds the message component by name.
     */
    "node_modules/ember-cli-notifications/dist/components/notification-container.js": `import { precompileTemplate } from "@ember/template-compilation";
export default precompileTemplate("{{#each this.messages as |m|}}<NotificationMessage @notification={{m}} />{{/each}}");
`,
  });
}

test("the addons' app trees go into app/, and the app's own files win", async () => {
  let app = cratesIo();

  expect(appTree.detect(app)).toBe(true);

  await appTree.run(app);

  expect(
    Object.fromEntries(
      app
        .files(["app/**/*.js"])
        .filter((file) => file !== "app/models/crate.js")
        .map((file) => [file, app.read(file)]),
    ),
  ).toMatchInlineSnapshot(`
    {
      "app/components/notification-message.js": "export * from "ember-cli-notifications/_app_/components/notification-message";
    export { default } from "ember-cli-notifications/_app_/components/notification-message";
    ",
      "app/initializers/ember-data.js": "export * from "ember-data/app/initializers/ember-data";
    export { default } from "ember-data/app/initializers/ember-data";
    ",
      "app/services/store.js": "export { default } from 'ember-data/store';
    ",
    }
  `);
  expect(appTree.detect(app)).toBe(false);
});

test("the packages that the app imports without declaring them become dependencies", async () => {
  let app = cratesIo();

  expect(declareImports.detect(app)).toBe(true);

  await declareImports.run(app);

  expect(app.packageJson.devDependencies).toMatchInlineSnapshot(`
    {
      "@ember-data/model": "5.8.2",
      "ember-cli-notifications": "9.1.0",
      "ember-data": "~5.8.2",
    }
  `);
  expect(declareImports.detect(app)).toBe(false);
});

test("without loose-mode templates, components, helpers and modifiers stay out of app/", async () => {
  let app = project({
    "package.json": { name: "app", devDependencies: { "ember-power-select": "^8.0.0" } },
    "app/components/picker.gjs": `import PowerSelect from "ember-power-select/components/power-select";
<template><PowerSelect @options={{@options}} as |o|>{{o}}</PowerSelect></template>
`,
    "node_modules/ember-power-select/package.json": {
      name: "ember-power-select",
      version: "8.0.0",
      keywords: ["ember-addon"],
      exports: { "./*": "./dist/*.js" },
      "ember-addon": {
        version: 2,
        "app-js": {
          "./components/power-select.js": "./dist/_app_/components/power-select.js",
          "./helpers/ember-power-select-is-equal.js":
            "./dist/_app_/helpers/ember-power-select-is-equal.js",
          "./services/power-select.js": "./dist/_app_/services/power-select.js",
        },
      },
    },
    "node_modules/ember-power-select/dist/components/power-select.js": `import { precompileTemplate } from "@ember/template-compilation";
export default precompileTemplate("<div></div>", { strictMode: true, scope: () => ({}) });
`,
  });

  await appTree.run(app);

  expect(app.files(["app/**/*.js"])).toMatchInlineSnapshot(`
    [
      "app/services/power-select.js",
    ]
  `);
});

test("a module is called by name with its dashed or its angle-bracket name", () => {
  let templates = [
    "{{outlet}}<this.ProvidedComponent />",
    "{{#if (eq @a @b)}}<PowerSelect::Trigger @select={{@select}} />{{/if}}",
  ];

  expect(
    [
      "./helpers/eq.js",
      "./components/power-select/trigger.js",
      "./components/provided-component.js",
      "./helpers/b.js",
      "./modifiers/outlet-tracker.js",
    ].map((appPath) => calledByName(appPath, templates)),
  ).toEqual([true, true, false, false, false]);
});

test("ember-data's store service and transforms come from the modules that it recommends", async () => {
  let app = project({
    "package.json": { name: "app", devDependencies: { "ember-data": "~5.8.2" } },
    "node_modules/ember-data/package.json": {
      name: "ember-data",
      version: "5.8.2",
      keywords: ["ember-addon"],
      exports: { "./app/*": { default: "./app/*.js" } },
      "ember-addon": {
        version: 2,
        "app-js": {
          "./services/store.js": "./app/services/store.js",
          "./transforms/date.js": "./app/transforms/date.js",
        },
      },
    },
  });

  await appTree.run(app);

  expect(Object.fromEntries(app.files(["app/**/*.js"]).map((file) => [file, app.read(file)])))
    .toMatchInlineSnapshot(`
    {
      "app/services/store.js": "export { default } from "ember-data/store";
    ",
      "app/transforms/date.js": "export { DateTransform as default } from "@ember-data/serializer/transform";
    ",
    }
  `);
});
