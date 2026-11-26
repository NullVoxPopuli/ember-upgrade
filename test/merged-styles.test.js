import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { mergedStyleImports, moveMergedStyleImports } from "#stages/addons/merged-styles.js";
import viteSass from "#stages/vite-sass/index.js";

/**
 * @param {string} directory
 * @param {Record<string, string | object>} files
 */
function write(directory, files) {
  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(
      join(directory, file),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
}

const HDS = "node_modules/@hashicorp/design-system-components";

/**
 * From hashicorp-forge/hermes: @hashicorp/design-system-components 3.6.0 is a v1 addon,
 * and 7.1.0 is a v2 addon with the same stylesheet in dist/styles.
 */
test("an import of a v1 addon's merged styles moves to the same file in the v2 addon", async () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  write(directory, {
    "package.json": {
      devDependencies: {
        "@embroider/vite": "^1.0.0",
        "@hashicorp/design-system-components": "^3.1.0",
        "ember-cli-sass": "^11.0.1",
      },
    },
    [`${HDS}/package.json`]: { name: "@hashicorp/design-system-components", version: "3.6.0" },
    [`${HDS}/app/styles/@hashicorp/design-system-components.scss`]: "",
    [`${HDS}/app/styles/@hashicorp/design-system-power-select-overrides.scss`]: "",
    "app/styles/app.scss": `@use "components/action";

@use "@hashicorp/design-system-components";

@use "./variables";
`,
    "app/styles/components/_action.scss": "",
    "app/styles/_variables.scss": "",
    "ember-cli-build.js": "module.exports = function (defaults) {};\n",
    "index.html": `<link rel="stylesheet" href="/@embroider/virtual/app.css">\n`,
  });

  let app = new Project(directory);
  let imports = mergedStyleImports(app, "@hashicorp/design-system-components");

  expect(imports).toMatchInlineSnapshot(`
    Map {
      "@hashicorp/design-system-components" => "@hashicorp/design-system-components.scss",
    }
  `);

  rmSync(join(directory, HDS), { recursive: true });
  write(directory, {
    [`${HDS}/package.json`]: {
      name: "@hashicorp/design-system-components",
      version: "7.1.0",
      "ember-addon": { version: 2 },
      exports: {
        ".": { types: "./declarations/index.d.ts", default: "./dist/index.js" },
        "./*": { types: "./declarations/*.d.ts", default: "./dist/*" },
        "./addon-main.js": "./addon-main.cjs",
      },
    },
    [`${HDS}/dist/styles/@hashicorp/design-system-components.scss`]: "",
  });

  expect(moveMergedStyleImports(app, "@hashicorp/design-system-components", imports)).toEqual([]);
  expect(app.read("app/styles/app.scss")).toMatchInlineSnapshot(`
    "@use "components/action";

    @use "node_modules/@hashicorp/design-system-components/dist/styles/@hashicorp/design-system-components";

    @use "./variables";
    "
  `);

  await viteSass.run(app);

  expect(app.read("app/styles/app.scss")).toMatchInlineSnapshot(`
    "@use "components/action";

    @use "@hashicorp/design-system-components/styles/@hashicorp/design-system-components.scss";

    @use "./variables";
    "
  `);
});
