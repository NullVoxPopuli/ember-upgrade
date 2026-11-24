import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { removeUnused, unusedDependencies } from "#stages/unused-dependencies/index.js";

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
 * From emberobserver/client after the upgrade, shortened.
 */
function observer() {
  return project({
    "package.json": {
      name: "ember-observer",
      scripts: { "test:ci": "testem ci --port 0", "lint:hbs": "ember-template-lint ." },
      devDependencies: {
        "@babel/core": "^7.29.0",
        "babel-eslint": "^10.1.0",
        "decorator-transforms": "^2.3.0",
        "ember-cli-deprecation-workflow": "^3.0.0",
        "ember-qunit": "^9.0.0",
        "ember-template-lint": "^7.0.0",
        eslint: "^4.19.0",
        "npm-run-all": "^4.1.5",
        prettier: "^3.10.1",
        qunit: "^2.26.0",
        sass: "^1.89.0",
        testem: "^3.16.0",
        vite: "^7.1.0",
      },
    },
    "babel.config.js": `module.exports = { plugins: [["decorator-transforms", {}]] };\n`,
    "tests/test-helper.js": `import { start } from "ember-qunit";\nstart();\n`,
    "app/styles/app.scss": `body { color: red; }\n`,
    "vite.config.mjs": `import { defineConfig } from "vite";\nexport default defineConfig({});\n`,
    ".prettierrc.js": `module.exports = { singleQuote: true };\n`,
    "config/deprecation-workflow.js": `window.deprecationWorkflow = { config: { workflow: [] } };\n`,
    "node_modules/ember-qunit/package.json": {
      name: "ember-qunit",
      peerDependencies: { qunit: "^2.0.0", "@ember/test-helpers": "*" },
    },
    "node_modules/vite/package.json": {
      name: "vite",
      bin: { vite: "bin/vite.js" },
      peerDependencies: { sass: "*", less: "*" },
      peerDependenciesMeta: { sass: { optional: true }, less: { optional: true } },
    },
    "node_modules/decorator-transforms/package.json": {
      name: "decorator-transforms",
      peerDependencies: { "@babel/core": "^7.0.0" },
    },
    "node_modules/testem/package.json": { name: "testem", bin: { testem: "testem.js" } },
    "node_modules/ember-template-lint/package.json": {
      name: "ember-template-lint",
      bin: "bin/ember-template-lint.js",
    },
    "node_modules/npm-run-all/package.json": {
      name: "npm-run-all",
      bin: { "npm-run-all": "bin/npm-run-all/index.js", "run-p": "bin/run-p/index.js" },
    },
    /**
     * Only babel-eslint has eslint as a peer, so eslint is unused after it.
     */
    "node_modules/babel-eslint/package.json": {
      name: "babel-eslint",
      peerDependencies: { eslint: ">= 4.12.1" },
    },
  });
}

test("a package is in use through an import, a config, a script, a config file or a peer", () => {
  expect(unusedDependencies(observer())).toMatchInlineSnapshot(`
    [
      "babel-eslint",
      "ember-cli-deprecation-workflow",
      "eslint",
      "npm-run-all",
    ]
  `);
});

test("a peer of an unused package is unused, and a removed package's files go", () => {
  let app = observer();

  expect(removeUnused(app)).toEqual(unusedDependencies(observer()));
  expect(Object.keys(app.packageJson.devDependencies ?? {})).toMatchInlineSnapshot(`
    [
      "@babel/core",
      "decorator-transforms",
      "ember-qunit",
      "ember-template-lint",
      "prettier",
      "qunit",
      "sass",
      "testem",
      "vite",
    ]
  `);
  expect(app.has("config/deprecation-workflow.js")).toBe(false);
});

test("without node_modules, no package is unused", () => {
  let app = project({
    "package.json": { name: "app", devDependencies: { "left-pad": "^1.0.0" } },
  });

  expect(unusedDependencies(app)).toEqual([]);
});

test("an app with an ember-cli build uses each addon in package.json", () => {
  let files = {
    "package.json": { name: "super-rentals", devDependencies: { "tracked-built-ins": "^3.3.0" } },
    "node_modules/tracked-built-ins/package.json": {
      name: "tracked-built-ins",
      keywords: ["ember-addon"],
    },
  };

  expect(unusedDependencies(project(files))).toEqual(["tracked-built-ins"]);
  expect(
    unusedDependencies(
      project(Object.assign({ "ember-cli-build.js": "module.exports = () => {};\n" }, files)),
    ),
  ).toEqual([]);
});
