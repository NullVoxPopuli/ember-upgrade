import { expect, test } from "vitest";

import { modernTemplateLintConfig, withoutDirectives } from "#stages/lint/index.js";

/**
 * From emberobserver/client.
 */
test("the template-lint config loses `pending` and extends `recommended`", () => {
  expect(
    modernTemplateLintConfig(
      `'use strict';

module.exports = {
  pending: [],
  extends: 'octane',
  rules: {
    'no-inline-styles': true,
    quotes: false,
  },
};
`,
      ".template-lintrc.js",
    ),
  ).toMatchInlineSnapshot(`
    "'use strict';

    module.exports = {
      extends: 'recommended',
      rules: {
        'no-inline-styles': true,
        quotes: false,
      },
    };
    "
  `);
});

test("a pending list over many lines goes, and other presets stay", () => {
  expect(
    modernTemplateLintConfig(
      `module.exports = {
  extends: ['octane', 'stylistic'],
  pending: [
    { moduleId: 'app/templates/index', only: ['no-bare-strings'] },
  ],
};
`,
      ".template-lintrc.js",
    ),
  ).toMatchInlineSnapshot(`
    "module.exports = {
      extends: ['recommended', 'stylistic'],
    };
    "
  `);
});

test("a modern config does not change", () => {
  expect(
    modernTemplateLintConfig(
      "module.exports = { extends: 'recommended' };\n",
      ".template-lintrc.js",
    ),
  ).toBeUndefined();
});

/**
 * From emberobserver/client, with the ranges that ESLint 10 reports.
 */
test("an unused directive goes with its line, or with the space before it", () => {
  let source = `on('error', function(error) {
    console.error(error);
  });
  // eslint-disable-line no-console
  on('warn', () => {});
  log(options); // eslint-disable-line no-console
  /* eslint-disable no-console, camelcase */
`;
  let comment = "// eslint-disable-line no-console";
  let own = source.indexOf(comment);
  let trailing = source.indexOf(comment, own + 1);
  let block = source.indexOf("/* eslint-disable");

  expect(
    withoutDirectives(source, [
      { range: [own, own + comment.length], text: " " },
      { range: [trailing, trailing + comment.length], text: " " },
      { range: [block, source.indexOf("*/") + 2], text: "/* eslint-disable no-console */" },
    ]),
  ).toMatchInlineSnapshot(`
    "on('error', function(error) {
        console.error(error);
      });
      on('warn', () => {});
      log(options);
      /* eslint-disable no-console */
    "
  `);
});
