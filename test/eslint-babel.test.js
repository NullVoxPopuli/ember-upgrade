import { expect, test } from "vitest";

import { withoutBabelConfigFile } from "#stages/ember-nvp/eslint-babel.js";

/**
 * From ember-learn/ember-website eslint.config.mjs (MIT), shortened.
 */
test("the Babel parser of ESLint does not load the Babel config of the app", () => {
  expect(
    withoutBabelConfigFile(
      `const parserOptions = {
  esm: {
    js: {
      babelOptions: {
        plugins: [['@babel/plugin-proposal-decorators', { version: 'legacy' }]],
      },
      requireConfigFile: false,
    },
  },
};
`,
      "eslint.config.mjs",
    ),
  ).toMatchInlineSnapshot(`
    "const parserOptions = {
      esm: {
        js: {
          babelOptions: { configFile: false,
            plugins: [['@babel/plugin-proposal-decorators', { version: 'legacy' }]],
          },
          requireConfigFile: false,
        },
      },
    };
    "
  `);
});
