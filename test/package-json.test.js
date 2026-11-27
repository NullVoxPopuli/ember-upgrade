import { expect, test } from "vitest";
import { setDependency } from "#package-json.js";

/**
 * From ember-learn/cli-guides: an earlier stage forced @glimmer/component 2,
 * and the ember-source 7.4 stage raised the range.
 */
test("a new range of a direct dependency also goes to its npm override", () => {
  let pkg = {
    devDependencies: { "@glimmer/component": "^2.0.0" },
    overrides: { "@glimmer/component": "^2.0.0", "ember-cli-babel": { "@babel/core": "^7.0.0" } },
  };

  setDependency(pkg, "@glimmer/component", "^2.2.1");

  expect(pkg).toEqual({
    devDependencies: { "@glimmer/component": "^2.2.1" },
    overrides: { "@glimmer/component": "^2.2.1", "ember-cli-babel": { "@babel/core": "^7.0.0" } },
  });
});
