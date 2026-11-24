import { expect, test } from "vitest";

import {
  withInstall,
  withWarpDriveInflection,
  withStrictTypes,
  withStringUtils,
  withTrackingResolved,
} from "#stages/warp-drive/index.js";

/**
 * The files are from emberobserver/client after the ember-nvp stage, shortened.
 */
test("app.js installs Ember's reactivity for WarpDrive", () => {
  expect(
    withInstall(`import Application from "@ember/application";
import config from "#config";
import loadInitializers from "ember-load-initializers";

export default class App extends Application {}
`),
  ).toMatchInlineSnapshot(`
    "import Application from "@ember/application";
    import config from "#config";
    import loadInitializers from "ember-load-initializers";
    import "@warp-drive/ember/install";

    export default class App extends Application {}
    "
  `);
});

test("the WarpDrive config marks the tracking package deprecation as resolved", () => {
  expect(
    withTrackingResolved(
      `import { buildMacros } from "@embroider/macros/babel";
import { setConfig } from "@warp-drive/core/build-config";

const macros = buildMacros({
  configure(config) {
    setConfig(config, {
      ___legacy_support: true,
    });
  },
});
`,
      "babel.config.js",
    ),
  ).toMatchInlineSnapshot(`
    "import { buildMacros } from "@embroider/macros/babel";
    import { setConfig } from "@warp-drive/core/build-config";

    const macros = buildMacros({
      configure(config) {
        setConfig(config, {
          ___legacy_support: true,
          deprecations: { DEPRECATE_TRACKING_PACKAGE: false },
        });
      },
    });
    "
  `);
});

test("inflector rules move to WarpDrive's string utilities", () => {
  expect(
    withStringUtils(
      `import Inflector from 'ember-inflector';

export function initialize(/* application */) {
  Inflector.inflector.uncountable('github-stats');
  Inflector.inflector.irregular('person', 'people');
}
`,
      "app/initializers/inflections.js",
    ),
  ).toMatchInlineSnapshot(`
    "import { irregular, uncountable } from "@warp-drive/utilities/string";

    export function initialize(/* application */) {
      uncountable('github-stats');
      irregular('person', 'people');
    }
    "
  `);
});

test("relationship types are normalized", () => {
  expect(
    withStrictTypes(
      `import Model, { attr, hasMany } from '@ember-data/model';

export default class TestResult extends Model {
  @attr('boolean') succeeded;
  @hasMany('emberVersionCompatibility', { async: true, inverse: null }) emberVersionCompatibilities;
  @hasMany('version', { async: true, inverse: null }) versions;
}
`,
      "app/models/test-result.js",
    ),
  ).toMatchInlineSnapshot(`
    "import Model, { attr, hasMany } from '@ember-data/model';

    export default class TestResult extends Model {
      @attr('boolean') succeeded;
      @hasMany('ember-version-compatibility', { async: true, inverse: null }) emberVersionCompatibilities;
      @hasMany('version', { async: true, inverse: null }) versions;
    }
    "
  `);
});

test("a Mirage server inflects with WarpDrive, which has the app's rules", () => {
  expect(
    withWarpDriveInflection(
      `import { createServer } from 'miragejs';
import { pluralize, singularize } from 'ember-inflector';

export default function makeServer(environment) {
  return createServer({ environment, inflector: { pluralize, singularize } });
}
`,
      "mirage/servers/default.js",
    ),
  ).toMatchInlineSnapshot(`
    "import { createServer } from 'miragejs';
    import { pluralize, singularize } from '@warp-drive/utilities/string';

    export default function makeServer(environment) {
      return createServer({ environment, inflector: { pluralize, singularize } });
    }
    "
  `);
  expect(
    withWarpDriveInflection(
      `import { pluralize } from 'ember-inflector';\n\nexport const label = pluralize(2, 'addon');\n`,
      "app/utils/label.js",
    ),
  ).toBeUndefined();
});
