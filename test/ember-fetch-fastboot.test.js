import { expect, test } from "vitest";

import { withFetchGlobals } from "#stages/addons/ember-fetch.js";

/**
 * From ember-learn/guides-source config/fastboot.js (MIT), shortened.
 */
test("FastBoot's sandbox gets the globals of fetch", () => {
  expect(
    withFetchGlobals(`module.exports = function () {
  return {
    buildSandboxGlobals(defaultGlobals) {
      return Object.assign({}, defaultGlobals, {
        atob: atob,
        AbortController,
        Headers: typeof Headers !== 'undefined' ? Headers : undefined,
      });
    },
  };
};
`),
  ).toMatchInlineSnapshot(`
    "module.exports = function () {
      return {
        buildSandboxGlobals(defaultGlobals) {
          return Object.assign({}, defaultGlobals, {
            atob: atob,
            AbortController,
            Headers: typeof Headers !== 'undefined' ? Headers : undefined,
            fetch,
            Request,
            Response,
          });
        },
      };
    };
    "
  `);
});
