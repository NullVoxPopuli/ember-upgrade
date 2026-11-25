import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { renameCommonJs } from "#stages/ember-nvp/index.js";

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
