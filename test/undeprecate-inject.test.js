import { expect, test } from "vitest";

import { addBabelMatch } from "#stages/undeprecate-inject/index.js";

/**
 * From rust-lang/crates.io, after the ember-nvp stage.
 */
test("ember() sends the files that import `inject` to babel", () => {
  expect(
    addBabelMatch(
      `import { defineConfig } from "vite";
import { ember } from "@nullvoxpopuli/ember-vite";

export default defineConfig({
  plugins: [scopedCSS(), ember(), svgJar({ target: 'ember' })],
});
`,
      "vite.config.mjs",
    ),
  ).toMatchInlineSnapshot(`
    "import { defineConfig } from "vite";
    import { ember } from "@nullvoxpopuli/ember-vite";

    export default defineConfig({
      plugins: [scopedCSS(), ember({ babel: { include: { whenMatching: [/\\binject\\b[^;]*from\\s*['"]@ember\\/service['"]/] } } }), svgJar({ target: 'ember' })],
    });
    "
  `);
});

test("ember() with options of its own is left to the person", () => {
  expect(
    addBabelMatch("export default { plugins: [ember({ production: {} })] };\n", "vite.config.mjs"),
  ).toBeUndefined();
});
