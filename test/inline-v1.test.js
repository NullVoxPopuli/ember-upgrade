import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { inlineV1Stage, withHasBlockHelpers } from "#stages/addons/inline-v1.js";

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
        "app/addons/emberx-select/components/x-legacy.hbs": "Old
    ",
        "app/addons/emberx-select/components/x-legacy.js": "import Component from '@ember/component';
    export default Component.extend({
      tagName: '',
    });
    ",
        "app/addons/emberx-select/services/x-registry.js": "export default class Registry {}
    ",
        "app/addons/emberx-select/utils/helper.js": "import { noop } from 'lodash';
    export function helper() {
      noop();
    }
    ",
        "app/components/category-position-dropdown.js": "import XSelect from './x-select.js';
    export default class extends XSelect {}
    ",
        "app/components/x-option.js": "export { default } from "./x-select";
    ",
        "app/components/x-select.hbs": "<select>{{yield}}</select>
    ",
        "app/components/x-select.js": "import Component from '@ember/component';
    import { helper } from '../addons/emberx-select/utils/helper';
    export default Component.extend({});
    ",
        "app/services/x-registry.js": "import Registry from '../addons/emberx-select/services/x-registry.js';
    export default class extends Registry {}
    ",
        "tests/helpers/emberx-select/index.js": "export function selectOption() {}
    ",
        "tests/helpers/index.js": "export function setupApplicationTest() {}
    ",
        "tests/helpers/x-select.js": "export default function select() {}
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
      "service": "export default class StripeService {}
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
