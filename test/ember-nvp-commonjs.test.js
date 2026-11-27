import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import {
  configModuleUsers,
  removeClassicVitePackages,
  removeOrphanConfigModules,
  renameCommonJs,
} from "#stages/ember-nvp/index.js";

/**
 * The files are from emberobserver/client after ember.nvp, shortened.
 */
test("the CommonJS configs of a module package become .cjs", () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));
  let files = {
    "package.json": JSON.stringify({ name: "app", type: "module" }),
    ".prettierrc.js": "'use strict';\n\nmodule.exports = {\n  singleQuote: true,\n};\n",
    ".template-lintrc.js": "'use strict';\n\nmodule.exports = {\n  extends: 'recommended',\n};\n",
    "eslint.config.js":
      "import ember from 'ember-eslint';\n\nexport default ember.recommended(import.meta.dirname);\n",
    "babel.config.mjs": "export default { plugins: [] };\n",
    "app/app.js": "import Application from '@ember/application';\n",
  };

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  let app = new Project(directory);

  expect(renameCommonJs(app)).toEqual([".prettierrc.js", ".template-lintrc.js"]);
  expect(app.files(["*", ".*", "app/*"])).toMatchInlineSnapshot(`
    [
      ".prettierrc.cjs",
      ".template-lintrc.cjs",
      "app",
      "app/app.js",
      "babel.config.mjs",
      "eslint.config.js",
      "package.json",
    ]
  `);
});

/**
 * From emberobserver/client (MIT), shortened. ember.nvp removes ember-cli-build.js and config/environment.js.
 */
test("a config module that only the replaced files required is removed", () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));
  let files = {
    "package.json": JSON.stringify({ name: "app" }),
    "ember-cli-build.js":
      "'use strict';\n\nconst parseFlag = require('./config/parse-flag');\n\nmodule.exports = function () {};\n",
    "config/environment.js":
      "'use strict';\n\nconst parseFlag = require('./parse-flag');\n\nmodule.exports = function () {};\n",
    "config/parse-flag.js": "'use strict';\n\nmodule.exports = function parseFlag() {};\n",
    "config/deploy.js":
      "'use strict';\n\nconst shared = require('./shared');\n\nmodule.exports = {};\n",
    "config/shared.js": "'use strict';\n\nmodule.exports = {};\n",
    "config/unused.js": "'use strict';\n\nmodule.exports = {};\n",
  };

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  let app = new Project(directory);
  let before = configModuleUsers(app);

  rmSync(join(directory, "ember-cli-build.js"));
  rmSync(join(directory, "config/environment.js"));

  expect(removeOrphanConfigModules(app, before)).toEqual(["config/parse-flag.js"]);
  expect(app.files(["*", "config/*"])).toMatchInlineSnapshot(`
    [
      "config",
      "config/deploy.js",
      "config/shared.js",
      "config/unused.js",
      "package.json",
    ]
  `);
});

/**
 * From ember-learn/cli-guides, an npm app: @rollup/plugin-babel asks for Babel 7, and ember.nvp moved the app to Babel 8.
 */
test("the Babel plugin of the classic Vite config goes when the ember.nvp configs do not import it", () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));
  let files = {
    "package.json": JSON.stringify({
      name: "app",
      devDependencies: { "@babel/core": "^8.1.4", "@rollup/plugin-babel": "^7.1.0" },
    }),
    "vite.config.mjs":
      "import { defineConfig } from 'vite';\nimport { ember } from '@nullvoxpopuli/ember-vite';\n\nexport default defineConfig({ plugins: [ember()] });\n",
    "babel.config.mjs": "export default { plugins: [] };\n",
  };

  for (let [file, contents] of Object.entries(files)) {
    writeFileSync(join(directory, file), contents);
  }

  let project = new Project(directory);

  expect(removeClassicVitePackages(project)).toEqual(["@rollup/plugin-babel"]);
  expect(project.packageJson.devDependencies).toEqual({ "@babel/core": "^8.1.4" });

  rmSync(directory, { recursive: true });
});
