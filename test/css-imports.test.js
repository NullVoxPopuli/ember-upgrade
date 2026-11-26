import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { fixStylesheetImports } from "#stages/ember-nvp/css-imports.js";

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

const REFOCUS = "node_modules/ember-a11y-refocus";

/**
 * From ember-learn/rfcs-app app/app.js, and the files of ember-a11y-refocus 5.2.1 (MIT).
 */
test("an import of a stylesheet that the package does not have names its one stylesheet", () => {
  let app = project({
    "package.json": JSON.stringify({
      dependencies: { "ember-a11y-refocus": "^5.1.0", "two-styles": "1.0.0" },
    }),
    [`${REFOCUS}/package.json`]: JSON.stringify({
      name: "ember-a11y-refocus",
      exports: {
        ".": { types: "./declarations/index.d.ts", default: "./dist/index.js" },
        "./addon-main.js": "./addon-main.cjs",
        "./*.css": "./dist/*.css",
        "./*": { types: "./declarations/*.d.ts", default: "./dist/*.js" },
      },
    }),
    [`${REFOCUS}/dist/styles/navigation-narrator.css`]: "",
    [`${REFOCUS}/src/styles/navigation-narrator.css`]: "",
    "node_modules/two-styles/package.json": JSON.stringify({ name: "two-styles" }),
    "node_modules/two-styles/a.css": "",
    "node_modules/two-styles/b.css": "",
    "app/app.js": `import Application from '@ember/application';
import 'ember-a11y-refocus/styles.css';
import 'ember-a11y-refocus/styles/navigation-narrator.css';
import 'two-styles/c.css';
`,
  });

  expect(fixStylesheetImports(app)).toEqual([
    "app/app.js: ember-a11y-refocus/styles.css -> ember-a11y-refocus/styles/navigation-narrator.css",
  ]);
  expect(app.read("app/app.js")).toMatchInlineSnapshot(`
    "import Application from '@ember/application';
    import 'ember-a11y-refocus/styles/navigation-narrator.css';
    import 'ember-a11y-refocus/styles/navigation-narrator.css';
    import 'two-styles/c.css';
    "
  `);
});

/**
 * ember-a11y-refocus 5.1.0 (MIT) exports `./styles.css` by name, before its `./*` pattern.
 */
test("an import that an exact key of the package's exports reaches stays", () => {
  let app = project({
    "package.json": JSON.stringify({ dependencies: { "ember-a11y-refocus": "^5.1.0" } }),
    [`${REFOCUS}/package.json`]: JSON.stringify({
      name: "ember-a11y-refocus",
      exports: {
        ".": { types: "./declarations/index.d.ts", default: "./dist/index.js" },
        "./*": { types: "./declarations/*.d.ts", default: "./dist/*.js" },
        "./addon-main.js": "./addon-main.cjs",
        "./styles.css": "./dist/styles/navigation-narrator.css",
      },
    }),
    [`${REFOCUS}/dist/styles/navigation-narrator.css`]: "",
    "app/app.js": "import 'ember-a11y-refocus/styles.css';\n",
  });

  expect(fixStylesheetImports(app)).toEqual([]);
});
