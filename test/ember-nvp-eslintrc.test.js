import { expect, test } from "vitest";

import { flatSettings, withFlatSettings } from "#stages/ember-nvp/eslintrc.js";

/**
 * The flat config that ember.nvp's eslint-bundled layer writes.
 */
const FLAT_CONFIG = `import { ember } from "ember-eslint";

export default [
  ...ember.recommended(import.meta.dirname),
  // your modifications here
];
`;

const KNOWN = new Set([
  "no-console",
  "ember/no-get",
  "ember/no-jquery",
  "n/no-unpublished-require",
]);

/**
 * Like ember-eslint, which defines eslint-plugin-ember for some files only.
 *
 * @type {import('#stages/ember-nvp/eslintrc.js').FlatRules}
 */
const RULES = {
  known: (rule) => KNOWN.has(rule),
  scope: (plugin) => (plugin === "ember" ? ["**/*.{js,ts}", "**/*.gjs"] : undefined),
};

/**
 * From emberobserver/client, without its comments.
 */
const OBSERVER = {
  root: true,
  parser: "babel-eslint",
  plugins: ["ember"],
  extends: ["eslint:recommended", "plugin:ember/recommended", "plugin:prettier/recommended"],
  env: { browser: true },
  rules: {
    "ember/no-get": "off",
    "ember/no-jquery": "error",
    "ember/require-tagless-components": "off",
  },
  overrides: [
    {
      files: ["tests/**/*.js"],
      excludedFiles: ["tests/dummy/**/*.js"],
      globals: { server: true },
    },
    {
      files: [".eslintrc.js", "config/**/*.js", "server/**/*.js"],
      parserOptions: { sourceType: "script" },
      env: { browser: false, node: true },
      plugins: ["node"],
      extends: ["plugin:node/recommended"],
      rules: { "node/no-unpublished-require": "off" },
    },
    {
      files: ["app/**/*.js"],
      rules: { "ember/no-get": "error", "no-console": "warn" },
    },
  ],
};

test("the globals and rule settings of the app carry over, with each enabled plugin rule in the files of its plugin", () => {
  expect(withFlatSettings(FLAT_CONFIG, flatSettings(OBSERVER, RULES))).toMatchInlineSnapshot(`
    "import { ember } from "ember-eslint";

    export default [
      ...ember.recommended(import.meta.dirname),
      // your modifications here
      {
        rules: {
          "ember/no-get": "off"
        }
      },
      {
        files: [
          "**/*.{js,ts}",
          "**/*.gjs"
        ],
        rules: {
          "ember/no-jquery": "error"
        }
      },
      {
        files: [
          "tests/**/*.js"
        ],
        ignores: [
          "tests/dummy/**/*.js"
        ],
        languageOptions: {
          globals: {
            server: true
          }
        }
      },
      {
        files: [
          ".eslintrc.js",
          "config/**/*.js",
          "server/**/*.js"
        ],
        rules: {
          "n/no-unpublished-require": "off"
        }
      },
      {
        files: [
          "app/**/*.js"
        ],
        rules: {
          "no-console": "warn"
        }
      },
      {
        files: [
          [
            "app/**/*.js",
            "**/*.{js,ts}"
          ],
          [
            "app/**/*.js",
            "**/*.gjs"
          ]
        ],
        rules: {
          "ember/no-get": "error"
        }
      },
    ];
    "
  `);
});

test("a config with only rules that the new config does not know adds nothing", () => {
  let settings = flatSettings({ rules: { "prettier/prettier": "error" } }, RULES);

  expect(settings).toEqual([]);
  expect(withFlatSettings(FLAT_CONFIG, settings)).toBeUndefined();
});
