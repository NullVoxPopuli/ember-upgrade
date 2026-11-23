import { expect, test } from "vitest";

import { addTaskTransform } from "#stages/ember-concurrency/index.js";

/**
 * From emberobserver/client, after the vite stage.
 */
test("the transform of ember-concurrency is the first babel plugin", () => {
  expect(
    addTaskTransform(
      `export default {
  plugins: [
    ['babel-plugin-ember-template-compilation', {}],
    ...babelCompatSupport(),
  ],
};
`,
      "babel.config.mjs",
    ),
  ).toMatchInlineSnapshot(`
    "export default {
      plugins: [
        "ember-concurrency/async-arrow-task-transform",
        ['babel-plugin-ember-template-compilation', {}],
        ...babelCompatSupport(),
      ],
    };
    "
  `);
});

test("a babel config without plugins is left to the person", () => {
  expect(addTaskTransform("export default {};\n", "babel.config.mjs")).toBeUndefined();
});
