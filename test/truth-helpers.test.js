import { expect, test } from "vitest";

import { truthHelperPaths } from "#stages/addons/truth-helpers.js";

/**
 * From ember-learn/upgrade-guide app/components/ember-versions-form.gjs, with a not-equal import added.
 */
test("the module paths of eq and not-eq are the ones of ember-truth-helpers 5", () => {
  expect(
    truthHelperPaths(`import { concat } from '@ember/helper';
import eq from 'ember-truth-helpers/helpers/equal';
import notEq from "ember-truth-helpers/helpers/not-equal";
import isEqual from 'ember-truth-helpers/helpers/is-equal';
`).template,
  ).toMatchInlineSnapshot(`
    "import { concat } from '@ember/helper';
    import eq from 'ember-truth-helpers/helpers/eq';
    import notEq from "ember-truth-helpers/helpers/not-eq";
    import isEqual from 'ember-truth-helpers/helpers/is-equal';
    "
  `);
});
