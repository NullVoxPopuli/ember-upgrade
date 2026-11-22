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
 * `x-legacy` imports its template as `layout`, as many v1 addons did.
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
      "import Component from '@ember/component';\nimport layout from '../templates/components/x-legacy';\nexport default Component.extend({\n  layout,\n  tagName: '',\n});\n",
    [`${ADDON}/addon/utils/helper.js`]: "export function helper() {}\n",
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
        "app/addons/emberx-select/utils/helper.js": "export function helper() {}
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
