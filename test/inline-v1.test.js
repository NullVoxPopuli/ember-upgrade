import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import {
  inlineV1Stage,
  placements,
  withDeprecationOwner,
  withHasBlockHelpers,
  withoutCompatibilityHelpers,
} from "#stages/addons/inline-v1.js";

/**
 * @param {Record<string, string>} files
 */
function project(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  return new Project(directory);
}

const ADDON = "node_modules/emberx-select";

/**
 * From emberx-select 3.1.1 and emberobserver/client, shortened.
 * `x-legacy` imports its template as `layout`, and reads the `Ember` global, as many v1 addons did.
 */
test("a v1 addon with no v2 release moves into the app", async () => {
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "emberx-select": "^3.1.1" } }),
    [`${ADDON}/package.json`]: JSON.stringify({
      name: "emberx-select",
      keywords: ["ember-addon"],
      dependencies: {
        "ember-cli-babel": "^6.6.0",
        "ember-cli-htmlbars": "^2.0.1",
        lodash: "^4.0.0",
      },
    }),
    [`${ADDON}/index.js`]: "'use strict';\nmodule.exports = {\n  name: 'emberx-select'\n};\n",
    [`${ADDON}/addon/components/x-select.js`]:
      "import Component from '@ember/component';\nimport { helper } from 'emberx-select/utils/helper';\nexport default Component.extend({});\n",
    [`${ADDON}/addon/components/x-legacy.js`]:
      "import Ember from 'ember';\nimport layout from '../templates/components/x-legacy';\nexport default Ember.Component.extend({\n  layout,\n  tagName: '',\n});\n",
    [`${ADDON}/addon/utils/helper.js`]:
      "import { noop } from 'lodash';\nexport function helper() {\n  noop();\n}\n",
    [`${ADDON}/addon/templates/components/x-select.hbs`]: "<select>{{yield}}</select>\n",
    [`${ADDON}/addon/templates/components/x-legacy.hbs`]: "Old\n",
    [`${ADDON}/app/components/x-select.js`]:
      "import XSelect from 'emberx-select/components/x-select';\nexport default XSelect;\n",
    [`${ADDON}/app/components/x-option.js`]:
      "export { default } from 'emberx-select/components/x-select';\n",
    [`${ADDON}/app/templates/components/x-select.js`]:
      "export { default } from 'emberx-select/templates/components/x-select';\n",
    [`${ADDON}/test-support/helpers/x-select.js`]: "export default function select() {}\n",
    [`${ADDON}/addon-test-support/index.js`]: "export function selectOption() {}\n",
    "tests/helpers/index.js": "export function setupApplicationTest() {}\n",
    [`${ADDON}/addon/services/x-registry.js`]: "export default class Registry {}\n",
    [`${ADDON}/app/services/x-registry.js`]:
      "export { default } from 'emberx-select/services/x-registry';\n",
    "app/services/x-registry.js":
      "import Registry from 'emberx-select/services/x-registry';\nexport default class extends Registry {}\n",
    "tests/integration/x-select-test.js":
      "import { selectOption } from 'emberx-select/test-support';\n",
    "app/components/category-position-dropdown.js":
      "import XSelect from 'emberx-select/components/x-select';\nexport default class extends XSelect {}\n",
  });

  let stage = inlineV1Stage(app, "emberx-select");

  expect(stage?.detect(app)).toBe(true);

  await stage?.run(app);

  let { devDependencies } = JSON.parse(app.read("package.json"));
  let files = app.files(["{app,tests}/**/*.*"]);

  expect({
    devDependencies,
    files: Object.fromEntries(files.map((file) => [file, app.read(file)])),
  }).toMatchInlineSnapshot(`
    {
      "devDependencies": {
        "lodash": "^4.0.0",
      },
      "files": {
        "app/addons/emberx-select/components/x-legacy.hbs": "{{!--
      Copied from emberx-select by ember-upgrade.
      emberx-select is a v1 addon with no v2 release,
      and the Vite build does not load v1 addons.
      To use the library again, once it has a v2 release:
      add emberx-select to package.json, import its modules
      from emberx-select again, and delete the files
      that have this comment.
    --}}
    Old
    ",
        "app/addons/emberx-select/components/x-legacy.js": "/**
     * Copied from emberx-select by ember-upgrade.
     * emberx-select is a v1 addon with no v2 release,
     * and the Vite build does not load v1 addons.
     * To use the library again, once it has a v2 release:
     * add emberx-select to package.json, import its modules
     * from emberx-select again, and delete the files
     * that have this comment.
     */
    import Component from '@ember/component';
    export default Component.extend({
      tagName: '',
    });
    ",
        "app/addons/emberx-select/services/x-registry.js": "/**
     * Copied from emberx-select by ember-upgrade.
     * emberx-select is a v1 addon with no v2 release,
     * and the Vite build does not load v1 addons.
     * To use the library again, once it has a v2 release:
     * add emberx-select to package.json, import its modules
     * from emberx-select again, and delete the files
     * that have this comment.
     */
    export default class Registry {}
    ",
        "app/addons/emberx-select/utils/helper.js": "/**
     * Copied from emberx-select by ember-upgrade.
     * emberx-select is a v1 addon with no v2 release,
     * and the Vite build does not load v1 addons.
     * To use the library again, once it has a v2 release:
     * add emberx-select to package.json, import its modules
     * from emberx-select again, and delete the files
     * that have this comment.
     */
    import { noop } from 'lodash';
    export function helper() {
      noop();
    }
    ",
        "app/components/category-position-dropdown.js": "import XSelect from './x-select.js';
    export default class extends XSelect {}
    ",
        "app/components/x-option.js": "/**
     * Copied from emberx-select by ember-upgrade.
     * emberx-select is a v1 addon with no v2 release,
     * and the Vite build does not load v1 addons.
     * To use the library again, once it has a v2 release:
     * add emberx-select to package.json, import its modules
     * from emberx-select again, and delete the files
     * that have this comment.
     */
    export { default } from "./x-select";
    ",
        "app/components/x-select.hbs": "{{!--
      Copied from emberx-select by ember-upgrade.
      emberx-select is a v1 addon with no v2 release,
      and the Vite build does not load v1 addons.
      To use the library again, once it has a v2 release:
      add emberx-select to package.json, import its modules
      from emberx-select again, and delete the files
      that have this comment.
    --}}
    <select>{{yield}}</select>
    ",
        "app/components/x-select.js": "/**
     * Copied from emberx-select by ember-upgrade.
     * emberx-select is a v1 addon with no v2 release,
     * and the Vite build does not load v1 addons.
     * To use the library again, once it has a v2 release:
     * add emberx-select to package.json, import its modules
     * from emberx-select again, and delete the files
     * that have this comment.
     */
    import Component from '@ember/component';
    import { helper } from '../addons/emberx-select/utils/helper';
    export default Component.extend({});
    ",
        "app/services/x-registry.js": "import Registry from '../addons/emberx-select/services/x-registry.js';
    export default class extends Registry {}
    ",
        "tests/helpers/emberx-select/index.js": "/**
     * Copied from emberx-select by ember-upgrade.
     * emberx-select is a v1 addon with no v2 release,
     * and the Vite build does not load v1 addons.
     * To use the library again, once it has a v2 release:
     * add emberx-select to package.json, import its modules
     * from emberx-select again, and delete the files
     * that have this comment.
     */
    export function selectOption() {}
    ",
        "tests/helpers/index.js": "export function setupApplicationTest() {}
    ",
        "tests/helpers/x-select.js": "/**
     * Copied from emberx-select by ember-upgrade.
     * emberx-select is a v1 addon with no v2 release,
     * and the Vite build does not load v1 addons.
     * To use the library again, once it has a v2 release:
     * add emberx-select to package.json, import its modules
     * from emberx-select again, and delete the files
     * that have this comment.
     */
    export default function select() {}
    ",
        "tests/integration/x-select-test.js": "import { selectOption } from '../helpers/emberx-select/index.js';
    ",
      },
    }
  `);
  expect(stage?.detect(app)).toBe(false);
});

test("a v1 addon with build hooks stays", () => {
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-tooltips": "^2.9.0" } }),
    "node_modules/ember-tooltips/package.json": JSON.stringify({ keywords: ["ember-addon"] }),
    "node_modules/ember-tooltips/index.js":
      "module.exports = {\n  name: 'ember-tooltips',\n  included(app) {\n    app.import('vendor/tether.js');\n  },\n};\n",
    "node_modules/ember-tooltips/addon/components/ember-tooltip.js": "export default {};\n",
  });

  expect(inlineV1Stage(app, "ember-tooltips")).toBeUndefined();
});

test("a v1 addon that exports something other than an object stays", () => {
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-engines": "^0.8.23" } }),
    "node_modules/ember-engines/package.json": JSON.stringify({ keywords: ["ember-addon"] }),
    "node_modules/ember-engines/index.js":
      "const ManifestGenerator = require('ember-asset-loader/lib/manifest-generator');\nmodule.exports = ManifestGenerator.extend({ name: 'ember-engines' });\n",
    "node_modules/ember-engines/addon/index.js": "export default {};\n",
  });

  expect(inlineV1Stage(app, "ember-engines")).toBeUndefined();
});

/**
 * From ember-one-way-select, in TryGhost/Ghost.
 */
test("inlined templates call has-block, which replaced the removed hasBlock property", () => {
  let template = `{{#if hasBlock}}
  {{yield}}
{{else if (and hasBlockParams @label)}}
  {{hasBlock}} {{~hasBlockParams~}}
{{/if}}
{{this.hasBlock}} {{@hasBlock}}
`;

  expect(withHasBlockHelpers(template)).toMatchInlineSnapshot(`
    "{{#if (has-block)}}
      {{yield}}
    {{else if (and (has-block-params) @label)}}
      {{has-block}} {{~has-block-params~}}
    {{/if}}
    {{this.hasBlock}} {{@hasBlock}}
    "
  `);
});

/**
 * From ember-autoresize 1.0.0, in code-corps/code-corps-ember.
 */
test("a v1 addon whose included hook only imports its dependencies moves in", () => {
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-autoresize": "1.0.0" } }),
    "node_modules/ember-autoresize/package.json": JSON.stringify({
      keywords: ["ember-addon"],
      dependencies: { "dom-ruler": "^0.2.5", "ember-cli-version-checker": "^2.1.0" },
    }),
    "node_modules/ember-autoresize/index.js": `'use strict';
let VersionChecker = require('ember-cli-version-checker');

module.exports = {
  name: 'ember-autoresize',

  included: function (app) {
    this._super.included.apply(this, arguments);
    let checker = new VersionChecker(this);

    checker.for('ember-cli').assertAbove('2.15.0', 'ember-cli 2.15 or greater is required');

    app.import('node_modules/dom-ruler/dist/amd/dom-ruler.js', {
      exports: { 'dom-ruler': ['default'] },
    });
  },
};
`,
    "node_modules/ember-autoresize/addon/mixins/autoresize.js":
      'import { measureText } from "dom-ruler";\nexport default {};\n',
  });

  expect(inlineV1Stage(app, "ember-autoresize")).toBeDefined();
});

test("a v1 addon whose included hook does more stays", () => {
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-cli-moment-shim": "3.0.0" } }),
    "node_modules/ember-cli-moment-shim/package.json": JSON.stringify({
      keywords: ["ember-addon"],
      dependencies: { moment: "^2.0.0" },
    }),
    "node_modules/ember-cli-moment-shim/index.js":
      "module.exports = {\n  name: 'ember-cli-moment-shim',\n  included(app) {\n    this.options = app.options.moment;\n    app.import('node_modules/moment/moment.js');\n  },\n};\n",
    "node_modules/ember-cli-moment-shim/addon/index.js": "export default {};\n",
  });

  expect(inlineV1Stage(app, "ember-cli-moment-shim")).toBeUndefined();
});

/**
 * From ember-stripe-elements 0.3.0 (MIT) and code-corps/code-corps-ember, shortened.
 */
test("the HTML of a contentFor hook goes into the app's HTML files", async () => {
  let addon = "node_modules/ember-stripe-elements";
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-stripe-elements": "^0.3.0" } }),
    "config/environment.js": `module.exports = function (environment) {
  let ENV = { stripe: {} };
  if (environment === 'test') ENV.stripe.mock = true;
  return ENV;
};
`,
    "index.html": `<html>
  <body>
    {{content-for "body"}}
    <script type="module" src="/app/app.js"></script>
    {{content-for "body-footer"}}
  </body>
</html>
`,
    "tests/index.html": `<html>
  <body>
    {{content-for "body"}}
    {{content-for "test-body"}}
  </body>
</html>
`,
    [`${addon}/package.json`]: JSON.stringify({
      name: "ember-stripe-elements",
      keywords: ["ember-addon"],
      dependencies: { "ember-cli-babel": "^6.6.0" },
    }),
    [`${addon}/index.js`]: `'use strict';
module.exports = {
  name: 'ember-stripe-elements',
  contentFor(type, config) {
    let stripeConfig = config.stripe || {};
    if (type === 'body' && !stripeConfig.lazyLoad && !stripeConfig.mock) {
      return '<script type="text/javascript" src="https://js.stripe.com/v3/"></script>';
    }
  }
};
`,
    [`${addon}/addon/services/stripev3.js`]: "export default class StripeService {}\n",
    [`${addon}/app/services/stripev3.js`]:
      "export { default } from 'ember-stripe-elements/services/stripev3';\n",
  });

  let stage = inlineV1Stage(app, "ember-stripe-elements");

  if (!stage) throw new Error("the addon stays a v1 addon");

  expect(await stage.check(app)).toEqual({ blockers: [], todo: [] });

  await stage.run(app);

  expect({
    index: app.read("index.html"),
    tests: app.read("tests/index.html"),
    service: app.read("app/services/stripev3.js"),
  }).toMatchInlineSnapshot(`
    {
      "index": "<html>
      <body>
        <script type="text/javascript" src="https://js.stripe.com/v3/"></script>
        {{content-for "body"}}
        <script type="module" src="/app/app.js"></script>
        {{content-for "body-footer"}}
      </body>
    </html>
    ",
      "service": "/**
     * Copied from ember-stripe-elements by ember-upgrade.
     * ember-stripe-elements is a v1 addon with no v2 release,
     * and the Vite build does not load v1 addons.
     * To use the library again, once it has a v2 release:
     * add ember-stripe-elements to package.json, import its modules
     * from ember-stripe-elements again, and delete the files
     * that have this comment.
     */
    export default class StripeService {}
    ",
      "tests": "<html>
      <body>
        {{content-for "body"}}
        {{content-for "test-body"}}
      </body>
    </html>
    ",
    }
  `);
});

/**
 * From ember-power-select-typeahead 0.8.1 (MIT): the hook asks ember-cli for another addon.
 */
test("an addon whose contentFor hook needs ember-cli stays a v1 addon", () => {
  let addon = "node_modules/ember-power-select-typeahead";
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: { "ember-power-select-typeahead": "^0.8.1" },
    }),
    "config/environment.js": "module.exports = function () {\n  return {};\n};\n",
    "index.html": '<html><body>\n{{content-for "body"}}\n</body></html>\n',
    [`${addon}/package.json`]: JSON.stringify({
      name: "ember-power-select-typeahead",
      keywords: ["ember-addon"],
    }),
    [`${addon}/index.js`]: `'use strict';
module.exports = {
  name: 'ember-power-select-typeahead',
  contentFor: function(type, config) {
    var emberPowerSelect = this.addons.filter(function(addon) {
      return addon.name === 'ember-power-select';
    })[0];
    return emberPowerSelect.contentFor(type, config);
  }
};
`,
    [`${addon}/addon/components/power-select-typeahead.js`]: "export default class {}\n",
  });

  expect(inlineV1Stage(app, "ember-power-select-typeahead")).toBeUndefined();
});

/**
 * From ember-app-scheduler 7.0.1 (MIT), shortened.
 */
test("the version checks of ember-compatibility-helpers get the answers for the app", () => {
  expect(
    withoutCompatibilityHelpers(
      `import { schedule } from '@ember/runloop';
import { gte } from 'ember-compatibility-helpers';

if (gte('3.6.0')) {
  schedule('afterRender', null, done);
}
`,
      [6, 12, 0],
    ),
  ).toMatchInlineSnapshot(`
    "import { schedule } from '@ember/runloop';

    if (true) {
      schedule('afterRender', null, done);
    }
    "
  `);
});

/**
 * From ember-app-scheduler 7.0.1 (MIT), shortened.
 */
test("a deprecation of inlined code names the addon, as Ember 4 asks", () => {
  expect(
    withDeprecationOwner(
      `import { deprecate } from '@ember/debug';

deprecate('setupRouter is deprecated', false, {
  id: 'ember-app-scheduler.setupRouter',
  until: '7.0.0',
});
`,
      "app/addons/ember-app-scheduler/scheduler.js",
      "ember-app-scheduler",
      "7.0.1",
    ),
  ).toMatchInlineSnapshot(`
    "import { deprecate } from '@ember/debug';

    deprecate('setupRouter is deprecated', false, {
      id: 'ember-app-scheduler.setupRouter',
      until: '7.0.0',
      for: 'ember-app-scheduler',
      since: { available: '7.0.1', enabled: '7.0.1' },
    });
    "
  `);
});

/**
 * From ember-toggle 7.1.1 (MIT) and documize/community, shortened.
 * The included hook picks the theme stylesheets from the app's config.
 */
test("the vendor files that an included hook imports go into the app, as ember-cli-build imports", async () => {
  let addon = "node_modules/ember-toggle";
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-toggle": "7.1.1" } }),
    "config/environment.js": `module.exports = function (environment) {
  return { environment, 'ember-toggle': { includedThemes: ['light', 'ios'] } };
};
`,
    "ember-cli-build.js": `'use strict';

const EmberApp = require('ember-cli/lib/broccoli/ember-app');

module.exports = function (defaults) {
  let app = new EmberApp(defaults, {});

  return app.toTree();
};
`,
    [`${addon}/package.json`]: JSON.stringify({
      name: "ember-toggle",
      keywords: ["ember-addon"],
      dependencies: { "ember-classic-decorator": "^2.0.0", "ember-cli-babel": "7.22.1" },
    }),
    [`${addon}/index.js`]: `'use strict';

module.exports = {
  name: require('./package').name,

  included: function (app, parentAddon) {
    var target = parentAddon || app;

    // necessary for nested usage
    // parent addon should call \`this._super.included.apply(this, arguments);\`
    if (target.app) {
      target = target.app;
    }

    this.app = target;

    // Use configuration to decide which theme css files
    // to import, thus not populating the user's app
    this.importThemes(target);
    this._super.included.apply(this, arguments);
  },

  importThemes: function (app) {
    var projectConfig = this.project.config(app.env);
    var config = projectConfig['ember-toggle'] || {};
    var excludeBaseStyles = config.excludeBaseStyles || false;
    var allThemes = [
      'light',
      'ios',
      'default',
      'flat',
      'skewed',
      'flip',
      'material',
    ];
    var included = config.includedThemes;
    var excluded = config.excludedThemes;
    var themes = [];

    if (included && Array.isArray(included)) {
      themes = themes.concat(included);
    } else {
      themes = allThemes;
    }

    if (excluded && Array.isArray(excluded)) {
      themes = themes.filter(function (theme) {
        return excluded.indexOf(theme) === -1;
      });
    }

    themes = themes.filter(function (theme) {
      return theme && allThemes.indexOf(theme) !== -1;
    });

    if (!excludeBaseStyles) {
      app.import('vendor/ember-toggle/base.css');
    }

    // Include all themes if user incorrectly specified themes in the config
    themes = themes.length ? themes : allThemes;

    themes.forEach(function (theme) {
      app.import('vendor/ember-toggle/themes/' + theme + '.css');
    });
  },
};
`,
    [`${addon}/vendor/ember-toggle/base.css`]: ".x-toggle { display: none; }\n",
    [`${addon}/vendor/ember-toggle/themes/light.css`]: ".x-toggle-light {}\n",
    [`${addon}/vendor/ember-toggle/themes/ios.css`]: ".x-toggle-ios {}\n",
    [`${addon}/addon/components/x-toggle/component.js`]: `import classic from 'ember-classic-decorator';
import { layout as templateLayout } from '@ember-decorators/component';
import Component from '@ember/component';
import layout from './template';

@classic
@templateLayout(layout)
export default class XToggle extends Component {}
`,
    [`${addon}/addon/components/x-toggle/template.hbs`]: "<label>{{this.onLabel}}</label>\n",
    [`${addon}/app/components/x-toggle.js`]:
      "export { default } from 'ember-toggle/components/x-toggle/component';\n",
  });

  let stage = inlineV1Stage(app, "ember-toggle");

  if (!stage) throw new Error("the addon stays a v1 addon");

  expect(await stage.check(app)).toEqual({ blockers: [], todo: [] });

  await stage.run(app);

  expect({
    build: app.read("ember-cli-build.js"),
    theme: app.read("vendor/ember-toggle/themes/ios.css"),
    component: app.read("app/components/x-toggle.js"),
    template: app.read("app/components/x-toggle.hbs"),
    dependencies: app.packageJson.devDependencies,
  }).toMatchInlineSnapshot(`
    {
      "build": "'use strict';

    const EmberApp = require('ember-cli/lib/broccoli/ember-app');

    module.exports = function (defaults) {
      let app = new EmberApp(defaults, {});
      app.import("vendor/ember-toggle/base.css");
      app.import("vendor/ember-toggle/themes/light.css");
      app.import("vendor/ember-toggle/themes/ios.css");

      return app.toTree();
    };
    ",
      "component": "/**
     * Copied from ember-toggle by ember-upgrade.
     * ember-toggle is a v1 addon with no v2 release,
     * and the Vite build does not load v1 addons.
     * To use the library again, once it has a v2 release:
     * add ember-toggle to package.json, import its modules
     * from ember-toggle again, and delete the files
     * that have this comment.
     */
    import Component from '@ember/component';

    export default class XToggle extends Component {}
    ",
      "dependencies": {},
      "template": "{{!--
      Copied from ember-toggle by ember-upgrade.
      ember-toggle is a v1 addon with no v2 release,
      and the Vite build does not load v1 addons.
      To use the library again, once it has a v2 release:
      add ember-toggle to package.json, import its modules
      from ember-toggle again, and delete the files
      that have this comment.
    --}}
    <label>{{this.onLabel}}</label>
    ",
      "theme": ".x-toggle-ios {}
    ",
    }
  `);
});

test("an addon whose included hook reads the build options stays a v1 addon", () => {
  let addon = "node_modules/ember-bootstrap-like";
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-bootstrap-like": "1.0.0" } }),
    "config/environment.js": "module.exports = function () {\n  return {};\n};\n",
    "ember-cli-build.js": "let app = new EmberApp(defaults, {});\n",
    [`${addon}/package.json`]: JSON.stringify({
      name: "ember-bootstrap-like",
      keywords: ["ember-addon"],
    }),
    [`${addon}/index.js`]: `module.exports = {
  name: 'ember-bootstrap-like',
  included(app) {
    let version = app.options['ember-bootstrap-like'].version;
    app.import('vendor/v' + version + '.css');
  }
};
`,
    [`${addon}/vendor/v3.css`]: "",
    [`${addon}/addon/components/x.js`]: "export default class {}\n",
  });

  expect(inlineV1Stage(app, "ember-bootstrap-like")).toBeUndefined();
});

test("an addon whose included hook imports a file for each environment stays a v1 addon", () => {
  let addon = "node_modules/env-imports";
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "env-imports": "1.0.0" } }),
    "config/environment.js": "module.exports = function () {\n  return {};\n};\n",
    "ember-cli-build.js": "let app = new EmberApp(defaults, {});\n",
    [`${addon}/package.json`]: JSON.stringify({ name: "env-imports", keywords: ["ember-addon"] }),
    [`${addon}/index.js`]: `module.exports = {
  name: 'env-imports',
  included(app) {
    app.import({ development: 'vendor/a.js', production: 'vendor/a.min.js' });
  }
};
`,
    [`${addon}/vendor/a.js`]: "",
    [`${addon}/addon/components/x.js`]: "export default class {}\n",
  });

  expect(inlineV1Stage(app, "env-imports")).toBeUndefined();
});

/**
 * From ember-href-to 5.1.1 (Apache-2.0), shortened: its app/ instance-initializer has its own code,
 * and imports the class of addon/href-to.js.
 */
test("an addon module that an app module only imports stays in the addon's folder", () => {
  let files = {
    "app/helpers/href-to.js": "export { default } from 'ember-href-to/helpers/href-to';\n",
    "app/instance-initializers/ember-href-to.js": `import HrefTo from 'ember-href-to/href-to';

export default {
  name: 'ember-href-to',
  initialize(applicationInstance) {},
};
`,
    "addon/helpers/href-to.js": "export default class HrefToHelper {}\n",
    "addon/href-to.js": "export default class {}\n",
  };

  expect(
    placements(
      "ember-href-to",
      Object.keys(files),
      (file) => files[/** @type {keyof typeof files} */ (file)],
      () => false,
    ),
  ).toMatchInlineSnapshot(`
    Map {
      "addon/helpers/href-to.js" => "app/helpers/href-to.js",
      "addon/href-to.js" => "app/addons/ember-href-to/href-to.js",
    }
  `);
});

/**
 * From @ember/legacy-built-in-components 0.4.2 (MIT), shortened: a colocated component and no app/ tree,
 * so the component stays in app/addons with its template.
 */
test("a v1 addon whose component stays in app/addons with its template waits for the Vite build", () => {
  let addon = "node_modules/@ember/legacy-built-in-components";
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: { "@ember/legacy-built-in-components": "^0.4.2" },
    }),
    [`${addon}/package.json`]: JSON.stringify({
      name: "@ember/legacy-built-in-components",
      keywords: ["ember-addon"],
      dependencies: { "ember-cli-babel": "^7.26.11", "ember-cli-htmlbars": "^6.0.1" },
    }),
    [`${addon}/index.js`]:
      "'use strict';\n\nmodule.exports = {\n  name: require('./package').name,\n};\n",
    [`${addon}/addon/components/checkbox.js`]:
      "import Component from '@ember/component';\nexport default class Checkbox extends Component {}\n",
    [`${addon}/addon/components/checkbox.hbs`]: "<input type='checkbox' />\n",
  });

  expect(inlineV1Stage(app, "@ember/legacy-built-in-components")?.needsVite).toBe(true);
});
