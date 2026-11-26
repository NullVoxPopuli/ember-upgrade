import { expect, test } from "vitest";

import { withDistFolder } from "#stages/ember-nvp/testem.js";

/**
 * From ember-learn/ember-website testem.cjs (MIT), shortened.
 */
test("testem serves the built files in dist/", () => {
  expect(
    withDistFolder(
      `'use strict';
if (typeof module !== 'undefined') {
  module.exports = {
    test_page: 'tests/index.html?hidepassed&nolint',
    disable_watching: true,
    launch_in_ci: ['Chrome'],
  };
}
`,
      "testem.cjs",
    ),
  ).toMatchInlineSnapshot(`
    "'use strict';
    if (typeof module !== 'undefined') {
      module.exports = {
        cwd: "dist",
        test_page: 'tests/index.html?hidepassed&nolint',
        disable_watching: true,
        launch_in_ci: ['Chrome'],
      };
    }
    "
  `);
});

test("a config with cwd stays the same", () => {
  let source = `module.exports = { test_page: 'tests/index.html', cwd: 'build' };\n`;

  expect(withDistFolder(source, "testem.cjs")).toBe(source);
});

test("a config on one line gets cwd on that line", () => {
  expect(withDistFolder(`module.exports = { test_page: 'tests/index.html' };\n`, "testem.cjs"))
    .toMatchInlineSnapshot(`
    "module.exports = { cwd: "dist", test_page: 'tests/index.html' };
    "
  `);
});
