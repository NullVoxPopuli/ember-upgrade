import { expect, test } from "vitest";

import { rewriteImports } from "#stages/pods/index.js";

/**
 * From CenterForOpenScience/ember-osf-web, shortened.
 */
const MODULES = new Map([
  ["app/guid-file/route.ts", "app/routes/guid-file.ts"],
  ["app/guid-file/route", "app/routes/guid-file"],
  [
    "app/home/-components/hero-banner/component.ts",
    "app/components/home/-components/hero-banner.ts",
  ],
  ["app/home/-components/hero-banner/component", "app/components/home/-components/hero-banner"],
  ["app/home/-components/hero-banner/styles.scss", "app/styles/home/-components/hero-banner.scss"],
  ["app/home/-components/hero-banner/styles", "app/styles/home/-components/hero-banner"],
  [
    "tests/integration/components/ancestry-display/component-test.ts",
    "tests/integration/components/ancestry-display-test.ts",
  ],
]);

test("imports point to the new paths of moved files", () => {
  let component = `import { requiredAction } from 'ember-osf-web/decorators/component';
import styles from './styles';
import GuidFile from 'ember-osf-web/guid-file/route';
`;
  let componentTest = `import { setupRenderingTest } from 'ember-qunit';
import stub from '../../../helpers/osf-link-router-stub';
`;
  let unmoved = `import Route from 'ember-osf-web/guid-file/route';
import helper from './helper';
`;

  expect({
    component: rewriteImports(component, {
      file: "app/components/home/-components/hero-banner.ts",
      origin: "app/home/-components/hero-banner/component.ts",
      prefix: "ember-osf-web",
      modules: MODULES,
    }),
    componentTest: rewriteImports(componentTest, {
      file: "tests/integration/components/ancestry-display-test.ts",
      origin: "tests/integration/components/ancestry-display/component-test.ts",
      prefix: "ember-osf-web",
      modules: MODULES,
    }),
    unmoved: rewriteImports(unmoved, {
      file: "tests/unit/routes/other-test.ts",
      origin: "tests/unit/routes/other-test.ts",
      prefix: "ember-osf-web",
      modules: MODULES,
    }),
  }).toMatchInlineSnapshot(`
    {
      "component": "import { requiredAction } from 'ember-osf-web/decorators/component';
    import styles from 'ember-osf-web/styles/home/-components/hero-banner';
    import GuidFile from 'ember-osf-web/routes/guid-file';
    ",
      "componentTest": "import { setupRenderingTest } from 'ember-qunit';
    import stub from 'ember-osf-web/tests/helpers/osf-link-router-stub';
    ",
      "unmoved": "import Route from 'ember-osf-web/routes/guid-file';
    import helper from './helper';
    ",
    }
  `);
});
