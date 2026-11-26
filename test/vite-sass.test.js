import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import viteSass from "#stages/vite-sass/index.js";

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
 * @param {Project} app
 * @param {string} file
 */
function dependencies(app, file = "package.json") {
  let { dependencies, devDependencies, overrides } = JSON.parse(app.read(file));

  return Object.assign({}, dependencies, devDependencies, {
    sass: devDependencies.sass?.replace(/\d+\.\d+\.\d+/, "x"),
    overrides: { "ember-cli-sass": overrides?.["ember-cli-sass"]?.replace(/\d+\.\d+\.\d+/, "x") },
  });
}

/**
 * From code-corps/code-corps-ember and emberobserver/client, shortened.
 */
test("Vite compiles the Sass, with the imports that ember-cli-sass resolved", async () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: {
        "@embroider/vite": "^1.0.0",
        "ember-cli-bourbon": "2.0.0-beta.1",
        "ember-cli-sass": "^7.0.0",
        "ember-modal-dialog": "2.4.1",
        "node-sass": "^4.5.3",
        "normalize.css": "^7.0.0",
        "ember-tooltips": "^2.9.0",
      },
    }),
    "node_modules/ember-tooltips/package.json": JSON.stringify({
      keywords: ["ember-addon"],
      dependencies: { "ember-cli-sass": "^7.0.0" },
    }),
    "node_modules/ember-cli-bourbon/package.json": JSON.stringify({
      keywords: ["ember-addon"],
      dependencies: { bourbon: "^4.2.0" },
    }),
    "node_modules/ember-cli-bourbon/node_modules/bourbon/package.json": "{}",
    "node_modules/ember-cli-bourbon/node_modules/bourbon/app/assets/stylesheets/_bourbon.scss": "",
    "node_modules/ember-modal-dialog/package.json": JSON.stringify({ keywords: ["ember-addon"] }),
    "node_modules/ember-modal-dialog/app/styles/ember-modal-dialog/_ember-modal-structure.scss": "",
    "node_modules/normalize.css/package.json": "{}",
    "node_modules/normalize.css/normalize.css": "",
    "node_modules/bourbon-neat/package.json": JSON.stringify({ version: "1.7.1" }),
    "node_modules/bourbon-neat/app/assets/stylesheets/_neat.scss": "",
    "ember-cli-build.js": `module.exports = function (defaults) {
  let app = new EmberApp(defaults, {
    sassOptions: { implementation: require('node-sass'), includePaths: ['app/shared'] },
    minifyCSS: { enabled: true },
  });
};
`,
    "index.html": `<link integrity="" rel="stylesheet" href="/@embroider/virtual/app.css">\n`,
    "tests/index.html": `<link rel="stylesheet" href="{{rootURL}}@embroider/virtual/app.css">\n`,
    "app/styles/app.scss": `@import "normalize";
@import "bourbon";
@import 'node_modules/bourbon-neat/app/assets/stylesheets/neat';
@import "ember-modal-dialog/ember-modal-structure";
@import "base/colors";
`,
    "app/styles/base/_colors.scss": "",
    "app/styles/layout/footer.scss": `@import "base/colors";\n@import "mixins";\n`,
    "app/shared/_mixins.scss": "",
  });

  expect(viteSass.detect(app)).toBe(true);

  await viteSass.run(app);

  expect({
    "app/styles/app.scss": app.read("app/styles/app.scss"),
    "app/styles/layout/footer.scss": app.read("app/styles/layout/footer.scss"),
    "ember-cli-build.js": app.read("ember-cli-build.js"),
    "index.html": app.read("index.html"),
    "tests/index.html": app.read("tests/index.html"),
    "package.json": dependencies(app),
  }).toMatchInlineSnapshot(`
    {
      "app/styles/app.scss": "@import "normalize.css/normalize";
    @import "bourbon/app/assets/stylesheets/bourbon";
    @import 'bourbon-neat/app/assets/stylesheets/neat';
    @import "ember-modal-dialog/app/styles/ember-modal-dialog/ember-modal-structure";
    @import "base/colors";
    ",
      "app/styles/layout/footer.scss": "@import "../base/colors";
    @import "../../shared/mixins";
    ",
      "ember-cli-build.js": "module.exports = function (defaults) {
      let app = new EmberApp(defaults, {
        minifyCSS: { enabled: true },
      });
    };
    ",
      "index.html": "<link integrity="" rel="stylesheet" href="/app/styles/app.scss">
    ",
      "package.json": {
        "@embroider/vite": "^1.0.0",
        "bourbon": "^4.2.0",
        "bourbon-neat": "^1.7.1",
        "ember-cli-bourbon": "2.0.0-beta.1",
        "ember-modal-dialog": "2.4.1",
        "ember-tooltips": "^2.9.0",
        "normalize.css": "^7.0.0",
        "overrides": {
          "ember-cli-sass": "^x",
        },
        "sass": "^x",
      },
      "tests/index.html": "<link rel="stylesheet" href="{{rootURL}}app/styles/app.scss">
    ",
    }
  `);
  expect(viteSass.detect(app)).toBe(false);
});

/**
 * From emberobserver/client, after the update to ember-power-select 8, which is a v2 addon with `exports`.
 */
test("an import into a package with exports gets the path that the package exports", async () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: {
        "@embroider/vite": "^1.0.0",
        "ember-cli-sass": "^11.0.1",
        "ember-power-select": "^8.12.1",
      },
    }),
    "node_modules/ember-power-select/package.json": JSON.stringify({
      keywords: ["ember-addon"],
      "ember-addon": { version: 2 },
      exports: {
        ".": { sass: "./ember-power-select.scss", default: "./dist/index.js" },
        "./*": { default: "./dist/*.js" },
        "./scss/base.scss": "./scss/base.scss",
        "./scss/variables.scss": "./scss/variables.scss",
        "./ember-power-select.scss": "./ember-power-select.scss",
      },
    }),
    "node_modules/ember-power-select/ember-power-select.scss": "",
    "node_modules/ember-power-select/scss/variables.scss": "",
    "ember-cli-build.js": "module.exports = function (defaults) {};\n",
    "index.html": `<link rel="stylesheet" href="/@embroider/virtual/app.css">\n`,
    "app/styles/app.scss": `@import "ember-power-select";
@import 'ember-power-select/scss/variables';
@import 'ember-power-select/ember-power-select';
@import 'ember-power-select/scss/base.scss';
`,
  });

  await viteSass.run(app);

  expect(app.read("app/styles/app.scss")).toMatchInlineSnapshot(`
    "@import "ember-power-select";
    @import 'ember-power-select/scss/variables.scss';
    @import 'ember-power-select';
    @import 'ember-power-select/scss/base.scss';
    "
  `);
});

/**
 * From hashicorp-forge/hermes (MPL-2.0), shortened. The Sass of @hashicorp/design-system-components uses `@use "tokens"`.
 */
test("the include paths in packages stay Sass load paths, in a Vite plugin", async () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: { "@embroider/vite": "^1.0.0", "ember-cli-sass": "^11.0.1" },
    }),
    "ember-cli-build.js": `module.exports = function (defaults) {
  let app = new EmberApp(defaults, {
    sassOptions: {
      includePaths: [
        "node_modules",
        "./node_modules/@hashicorp/design-system-tokens/dist/products/css",
      ],
    },
  });
};
`,
    "vite.config.mjs": `import { defineConfig } from 'vite';
import { ember } from '@embroider/vite';

export default defineConfig({
  plugins: [ember()],
});
`,
    "app/styles/app.scss": "",
  });

  await viteSass.run(app);

  expect(app.read("vite.config.mjs")).toMatchInlineSnapshot(`
    "import { defineConfig } from 'vite';
    import { ember } from '@embroider/vite';
    import sassLoadPaths from './vite/sass-load-paths.mjs';

    export default defineConfig({
      plugins: [ember(), sassLoadPaths],
    });
    "
  `);
  expect(app.read("vite/sass-load-paths.mjs")).toMatchInlineSnapshot(`
    "import { resolve } from 'node:path';

    /**
     * The stylesheets of packages import from these folders, which ember-cli-sass searched with \`includePaths\`.
     */
    const LOAD_PATHS = ["node_modules/@hashicorp/design-system-tokens/dist/products/css"].map((path) => resolve(import.meta.dirname, '..', path));

    export default {
      name: 'sass-load-paths',
      config() {
        return {
          css: {
            preprocessorOptions: {
              scss: { loadPaths: LOAD_PATHS },
              sass: { loadPaths: LOAD_PATHS },
            },
          },
        };
      },
    };
    "
  `);
});

/**
 * From hashicorp-forge/hermes (MPL-2.0), shortened, after the update to ember-power-select 8.
 */
test("a relative import of a package folder names the index file that the package exports", async () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: {
        "@embroider/vite": "^1.0.0",
        "ember-cli-sass": "^11.0.1",
        "ember-power-select": "^8.12.0",
      },
    }),
    "node_modules/ember-power-select/package.json": JSON.stringify({
      version: "8.12.0",
      exports: {
        ".": { types: "./declarations/index.d.ts", default: "./dist/index.js" },
        "./_index.scss": "./_index.scss",
        "./ember-power-select.scss": "./ember-power-select.scss",
      },
    }),
    "node_modules/ember-power-select/_index.scss": "",
    "node_modules/ember-power-select/ember-power-select.scss": "",
    "app/styles/app.scss": `@use "ember-power-select-theme";\n`,
    "app/styles/ember-power-select-theme.scss": `@import "../../node_modules/ember-power-select";\n`,
  });

  await viteSass.run(app);

  expect(app.read("app/styles/ember-power-select-theme.scss")).toMatchInlineSnapshot(`
    "@import "ember-power-select/_index.scss";
    "
  `);
});
