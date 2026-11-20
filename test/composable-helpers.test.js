import { expect, test } from "vitest";

import { renameImports } from "#stages/addons/composable-helpers.js";

test("imports move to the fork, with the same paths", () => {
  expect(
    renameImports(
      `import { pipe } from 'ember-composable-helpers/helpers/pipe';
import "ember-composable-helpers";
export { default } from "ember-composable-helpers/helpers/map-by";
import { compute } from 'other-addon/ember-composable-helpers';
`,
      "app/helpers/x.js",
    ),
  ).toBe(`import { pipe } from '@nullvoxpopuli/ember-composable-helpers/helpers/pipe';
import "@nullvoxpopuli/ember-composable-helpers";
export { default } from "@nullvoxpopuli/ember-composable-helpers/helpers/map-by";
import { compute } from 'other-addon/ember-composable-helpers';
`);
});
