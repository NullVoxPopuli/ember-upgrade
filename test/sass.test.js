import { expect, test } from "vitest";

import { withPercentUnits, withQuietDeps } from "#stages/sass/index.js";

test("the color migration's lightness gets its percent unit", () => {
  expect(
    withPercentUnits(`h1 {
  color: color.adjust($blue, $lightness: -5, $space: hsl);
  background: color.adjust($gray, $lightness: 20%, $space: hsl);
  border-color: color.adjust($gray, $saturation: 12.5, $alpha: -0.2);
}
`),
  ).toMatchInlineSnapshot(`
    "h1 {
      color: color.adjust($blue, $lightness: -5%, $space: hsl);
      background: color.adjust($gray, $lightness: 20%, $space: hsl);
      border-color: color.adjust($gray, $saturation: 12.5%, $alpha: -0.2);
    }
    "
  `);
});

test("Sass leaves out the deprecations of dependencies", () => {
  expect(
    withQuietDeps(
      `import { defineConfig } from "vite";
import { ember } from "@nullvoxpopuli/ember-vite";

export default defineConfig({
  plugins: [ember()],
});
`,
      "vite.config.mjs",
    ),
  ).toMatchInlineSnapshot(`
    "import { defineConfig } from "vite";
    import { ember } from "@nullvoxpopuli/ember-vite";

    export default defineConfig({
      plugins: [ember()],
      css: { preprocessorOptions: { scss: { quietDeps: true } } },
    });
    "
  `);
  expect(
    withQuietDeps(
      `export default defineConfig({ css: { devSourcemap: true } });\n`,
      "vite.config.mjs",
    ),
  ).toBeUndefined();
});
