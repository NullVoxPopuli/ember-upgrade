import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import appTree from "#stages/app-tree/index.js";
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
