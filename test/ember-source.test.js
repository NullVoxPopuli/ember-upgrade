import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { classicLts, viteLts } from "#stages/ember-source/index.js";
import { withoutCompilerPath } from "#stages/ember-source/compiler-path.js";
import { withoutInternetExplorer } from "#stages/ember-source/targets.js";
import { withoutKeywordImports } from "#stages/ember-source/helper-keywords.js";
import {
  arrayMacroGetters,
  explicitRelationships,
  nativeArrayMethods,
  readHasManyAsArray,
  unwrapRelationshipValues,
  withoutFirstAndLastObject,
} from "#stages/ember-source/ember-data.js";
import { renameTitleHelper } from "#stages/ember-source/page-title.js";
import {
  builtInAttributes,
  withOnImport,
  extendsArrays,
  queryParamsList,
  rewriteWith,
  useServiceImport,
} from "#stages/ember-source/removed-apis.js";
import { moveImports } from "#codemods/move-imports.js";

/**
 * @param {Record<string, unknown>} pkg
 */
function project(pkg) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  writeFileSync(join(directory, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  return new Project(directory);
}

/**
 * The versions in TryGhost/Ghost ghost/admin at 6c43413, shortened.
 */
const GHOST = {
  name: "ghost-admin",
  devDependencies: {
    "ember-cli": "~4.12.3",
    "ember-data": "3.24.0",
    "ember-qunit": "5.1.5",
    "ember-resolver": "8.0.3",
    "ember-source": "3.24.0",
    "ember-auto-import": "catalog:",
    "@tryghost/kg-clean-basic-html": "workspace:*",
  },
};

test("one stage for each LTS above the app's version, with 7.x after the vite stage", async () => {
  let app = project(GHOST);
  let stages = (await classicLts.expand(app)).concat(await viteLts.expand(app));

  expect(stages.map((stage) => stage.name)).toEqual([
    "ember-source-3.28",
    "ember-source-4.4",
    "ember-source-4.8",
    "ember-source-4.12",
    "ember-source-5.4",
    "ember-source-5.8",
    "ember-source-5.12",
    "ember-source-6.4",
    "ember-source-6.8",
    "ember-source-6.12",
    "ember-source-7.4",
  ]);
});

test("a step updates the blueprint packages that the app has, and only up, so exact pins at the same version stay", async () => {
  let app = project(GHOST);
  let [first] = await classicLts.expand(app);

  await first.run(app);

  expect(first.detect(app)).toBe(false);
  expect(app.packageJson.devDependencies).toEqual({
    "ember-cli": "~4.12.3",
    "ember-data": "~3.28.6",
    "ember-qunit": "5.1.5",
    "ember-resolver": "8.0.3",
    "ember-source": "~3.28.12",
    "ember-auto-import": "catalog:",
    "@tryghost/kg-clean-basic-html": "workspace:*",
  });
});

test("an app on an LTS gets no step for it", async () => {
  let app = project({ devDependencies: { "ember-source": "~6.12.0" } });

  expect(await classicLts.expand(app)).toEqual([]);
  expect((await viteLts.expand(app)).map((stage) => stage.name)).toEqual(["ember-source-7.4"]);
});

/**
 * From hashicorp-forge/hermes web/package.json, shortened.
 * ember-a11y-refocus and ember-app-scheduler depend on @glimmer/component 1.
 */
test("the step to @glimmer/component 2 overrides it for the addons too", async () => {
  let app = project({
    name: "hermes",
    packageManager: "pnpm@10.0.0",
    devDependencies: {
      "@glimmer/component": "^1.1.2",
      "ember-a11y-refocus": "^3.0.2",
      "ember-source": "~5.12.0",
    },
  });

  writeFileSync(join(app.directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  let [step] = await classicLts.expand(app);

  expect(step.name).toBe("ember-source-6.4");

  await step.run(app);

  expect(app.dependency("@glimmer/component")).toBe("^2.0.0");
  expect(app.read("pnpm-workspace.yaml")).toMatchInlineSnapshot(`
    "overrides:
      '@glimmer/component': '^2.0.0'
    "
  `);
});

/**
 * From code-corps/code-corps-ember (MIT), shortened.
 */
test("the title helper of ember-page-title 3 becomes page-title", () => {
  expect(
    renameTitleHelper(`{{title "Settings"}}
{{~title (concat model.name " Tasks") separator=" | "}}
<h1 title={{title}}>{{title}}</h1>
`),
  ).toMatchInlineSnapshot(`
    "{{page-title "Settings"}}
    {{~page-title (concat model.name " Tasks") separator=" | "}}
    <h1 title={{title}}>{{title}}</h1>
    "
  `);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("with becomes let inside if, and nested ones too", () => {
  expect(
    rewriteWith(`{{#with this.model.addon as |addon|}}
  {{#with addon.latestReview as |review|}}{{review.score}}{{/with}}
{{else}}
  No addon
{{/with}}
`),
  ).toMatchInlineSnapshot(`
    "{{#if this.model.addon}}{{#let this.model.addon as |addon|}}
      {{#if addon.latestReview}}{{#let addon.latestReview as |review|}}{{review.score}}{{/let}}{{/if}}
    {{/let}}{{else}}
      No addon
    {{/if}}
    "
  `);
});

test("htmlSafe moves from @ember/string to @ember/template", () => {
  expect(
    moveImports(
      `import { htmlSafe } from '@ember/string';\n`,
      "app/helpers/dom-purify.js",
      "@ember/string",
      "@ember/template",
      (name) => name === "htmlSafe",
    ),
  ).toBe(`import { htmlSafe } from '@ember/template';\n`);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("inject from @ember/service becomes service, with the same local name", () => {
  expect(
    useServiceImport(
      `import Service, { inject as service } from '@ember/service';
import { inject } from '@ember/service';
`,
      "app/services/search.js",
    ),
  ).toBe(`import Service, { service } from '@ember/service';
import { service as inject } from '@ember/service';
`);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("relationships get the async and inverse that ember-data used to find", () => {
  let result = explicitRelationships(
    new Map([
      [
        "addon",
        `import Model, { belongsTo, hasMany } from '@ember-data/model';
export default class Addon extends Model {
  @belongsTo('version') latestAddonVersion;
  @hasMany('version') versions;
}
`,
      ],
      [
        "version",
        `import Model, { belongsTo } from '@ember-data/model';
export default class Version extends Model {
  @belongsTo('addon', { inverse: 'versions' }) addon;
  @belongsTo('review') review;
}
`,
      ],
      [
        "review",
        `import Model, { belongsTo } from '@ember-data/model';
export default class Review extends Model {
  @belongsTo('version') version;
}
`,
      ],
    ]),
  );

  expect(result.unreadable).toEqual([]);
  expect(Object.fromEntries(result.files)).toMatchInlineSnapshot(`
    {
      "addon": "import Model, { belongsTo, hasMany } from '@ember-data/model';
    export default class Addon extends Model {
      @belongsTo('version', { async: true, inverse: null }) latestAddonVersion;
      @hasMany('version', { async: true, inverse: 'addon' }) versions;
    }
    ",
      "review": "import Model, { belongsTo } from '@ember-data/model';
    export default class Review extends Model {
      @belongsTo('version', { async: true, inverse: 'review' }) version;
    }
    ",
      "version": "import Model, { belongsTo } from '@ember-data/model';
    export default class Version extends Model {
      @belongsTo('addon', { inverse: 'versions', async: true }) addon;
      @belongsTo('review', { async: true, inverse: 'version' }) review;
    }
    ",
    }
  `);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("a relationship without a type gets the one that ember-data took from the field", () => {
  let result = explicitRelationships(
    new Map([
      [
        "score-calculation",
        `import Model, { belongsTo } from '@ember-data/model';
export default class ScoreCalculation extends Model {
  @belongsTo()
  addon;
}
`,
      ],
      [
        "addon",
        `import Model from '@ember-data/model';\nexport default class Addon extends Model {}\n`,
      ],
    ]),
  );

  expect(result.files.get("score-calculation")).toMatchInlineSnapshot(`
    "import Model, { belongsTo } from '@ember-data/model';
    export default class ScoreCalculation extends Model {
      @belongsTo('addon', { async: true, inverse: null })
      addon;
    }
    "
  `);
});

test("an app extends arrays unless EXTEND_PROTOTYPES turns arrays off", () => {
  expect(extendsArrays("EmberENV: { EXTEND_PROTOTYPES: { Date: false } }")).toBe(true);
  expect(extendsArrays("EmberENV: {}")).toBe(true);
  expect(extendsArrays("EmberENV: { EXTEND_PROTOTYPES: false }")).toBe(false);
  expect(extendsArrays("EmberENV: { EXTEND_PROTOTYPES: { Date: false, Array: false } }")).toBe(
    false,
  );
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("firstObject, lastObject and the reading array extensions become native array reads", () => {
  let source = `import { get } from '@ember/object';
let addon = addons.get('firstObject');
let earliest = get(this, 'sortedVersionCompatibilities.lastObject.emberVersion');
let names = users.toArray().mapBy('name');
let match = list.findBy('id', item.id);
let sorted = (versions || []).sortBy('released').reverse();
`;

  expect(nativeArrayMethods(withoutFirstAndLastObject(source, "a.js"), "a.js"))
    .toMatchInlineSnapshot(`
    "import { compare } from '@ember/utils';
    import asArray from 'app/utils/as-array';
    import { get } from '@ember/object';
    let addon = asArray(addons)[0];
    let earliest = asArray(get(this, 'sortedVersionCompatibilities')).slice(-1)[0]?.emberVersion;
    let names = asArray(users).slice().map((item) => get(item, 'name'));
    let match = asArray(list).find((element) => get(element, 'id') === item.id);
    let sorted = asArray(versions || []).slice().sort((a, b) => compare(get(a, 'released'), get(b, 'released'))).reverse();
    "
  `);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("a value that the code assigns to a relationship reads the record of an async belongsTo", () => {
  expect(
    unwrapRelationshipValues(
      `set(newReview, 'version', get(this, 'addon.latestAddonVersion'));
set(newReview, 'score', 5);
`,
      "app/components/admin-addon.js",
      new Set(["version"]),
      "ember-observer/utils/as-array",
    ),
  ).toMatchInlineSnapshot(`
    "import { asRecord } from 'ember-observer/utils/as-array';
    set(newReview, 'version', asRecord(get(this, 'addon.latestAddonVersion')));
    set(newReview, 'score', 5);
    "
  `);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("a native array method on an async hasMany reads through asArray", () => {
  expect(
    readHasManyAsArray(
      `let released = get(this.args, 'testResult.emberVersionCompatibilities').filter((v) => v.released);\n`,
      "app/components/ember-version-compatibility.js",
      new Set(["emberVersionCompatibilities"]),
      "ember-observer/utils/as-array",
    ),
  ).toMatchInlineSnapshot(`
    "import asArray from 'ember-observer/utils/as-array';
    let released = asArray(get(this.args, 'testResult.emberVersionCompatibilities')).filter((v) => v.released);
    "
  `);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("an array macro becomes a getter that reads the list through asArray", () => {
  expect(
    arrayMacroGetters(
      `import { sort, filterBy } from '@ember/object/computed';
import Component from '@glimmer/component';
import Controller from '@ember/controller';

export class InlineCategoryList extends Component {
  categorySorting = ['totalAddonCount:desc'];

  @sort('args.categories', 'categorySorting')
  categoriesSortedByAddonCount;
}

export class ShowController extends Controller {
  @filterBy('model.addons', 'isDeprecated', false)
  activeAddons;

  @sort('activeAddons', function (a, b) {
    return this.compare(a, b);
  })
  sortedAddons;
}
`,
      "app/components/inline-category-list.js",
      "ember-observer/utils/as-array",
    ),
  ).toMatchInlineSnapshot(`
    "import Component from '@glimmer/component';
    import Controller from '@ember/controller';
    import { get } from '@ember/object';
    import asArray, { sortBy } from 'ember-observer/utils/as-array';

    export class InlineCategoryList extends Component {
      categorySorting = ['totalAddonCount:desc'];

      get categoriesSortedByAddonCount() {
        return sortBy(this.args?.categories, this.categorySorting);
      }
    }

    export class ShowController extends Controller {
      get activeAddons() {
        return asArray(get(this, 'model.addons')).filter((item) => item.isDeprecated === false);
      }

      get sortedAddons() {
        return asArray(get(this, 'activeAddons')).slice().sort((a, b) => {
          return this.compare(a, b);
        });
      }
    }
    "
  `);
});

test("an object of query params becomes the one entry of the list", () => {
  expect(
    queryParamsList(
      `export default class ShowController extends Controller {
  queryParams = { addonSortKey: 'sort' };

  selectList(list) {
    this.router.transitionTo('admin.review', { queryParams: { list: list.key } });
  }
}
`,
      "app/controllers/categories/show.js",
    ),
  ).toMatchInlineSnapshot(`
    "export default class ShowController extends Controller {
      queryParams = [{ addonSortKey: 'sort' }];

      selectList(list) {
        this.router.transitionTo('admin.review', { queryParams: { list: list.key } });
      }
    }
    "
  `);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("the attributes that Input took as arguments become attributes", () => {
  expect(
    builtInAttributes(
      `<Input @type="search" @id="code-search-input" @spellcheck="false" @value={{this.query}} />\n`,
    ),
  ).toBe(
    `<Input @type="search" id="code-search-input" spellcheck="false" @value={{this.query}} />\n`,
  );
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("an event handler that Input took as an argument becomes the on modifier", () => {
  expect(
    withOnImport(
      builtInAttributes(
        `import perform from "ember-concurrency/helpers/perform";

<template>
  <Input @type="checkbox" id="search-readmes" @checked={{@searchReadmes}} @change={{perform this.toggleReadmeSearch}} />
</template>
`,
      ),
      "app/components/large-search.gjs",
    ),
  ).toMatchInlineSnapshot(`
    "import perform from "ember-concurrency/helpers/perform";
    import { on } from '@ember/modifier';

    <template>
      <Input @type="checkbox" id="search-readmes" @checked={{@searchReadmes}} {{on "change" (perform this.toggleReadmeSearch)}} />
    </template>
    "
  `);
});

test("the ember-data rewrites change nothing on a second step", () => {
  let source = `set(review, 'version', get(this, 'addon.latestAddonVersion'));
let released = get(this.args, 'testResult.emberVersionCompatibilities').filter((v) => v.released);
let first = addons.get('firstObject');
let count = model.addons.get('length');
let names = list.mapBy('name');
`;
  let names = new Set(["version", "emberVersionCompatibilities"]);
  let once = (/** @type {string} */ text) =>
    readHasManyAsArray(
      unwrapRelationshipValues(
        nativeArrayMethods(withoutFirstAndLastObject(text, "a.js"), "a.js"),
        "a.js",
        names,
      ),
      "a.js",
      names,
    );
  let first = once(source);

  expect(once(first)).toBe(first);
});

/**
 * From ember-learn/rfcs-app babel.config.cjs, shortened.
 */
test("the compilerPath of ember-source 6 goes for ember-source 7", () => {
  expect(
    withoutCompilerPath(
      `module.exports = {
  plugins: [
    [
      'babel-plugin-ember-template-compilation',
      {
        compilerPath: 'ember-source/dist/ember-template-compiler.js',
        enableLegacyModules: ['ember-cli-htmlbars'],
      },
    ],
  ],
};
`,
      "babel.config.cjs",
    ),
  ).toMatchInlineSnapshot(`
    "module.exports = {
      plugins: [
        [
          'babel-plugin-ember-template-compilation',
          {
            enableLegacyModules: ['ember-cli-htmlbars'],
          },
        ],
      ],
    };
    "
  `);
});

/**
 * From ember-learn/deprecation-app config/targets.js, with a push added.
 */
test("Internet Explorer goes from the targets of ember-source 5", () => {
  expect(
    withoutInternetExplorer(`'use strict';

const browsers = [
  'last 1 Chrome versions',
  'last 1 Safari versions',
  'ie 11',
];

if (process.env.LEGACY) {
  browsers.push('ie 11');
}

module.exports = {
  browsers,
};
`),
  ).toMatchInlineSnapshot(`
    "'use strict';

    const browsers = [
      'last 1 Chrome versions',
      'last 1 Safari versions',
    ];

    if (process.env.LEGACY) {
    }

    module.exports = {
      browsers,
    };
    "
  `);
});

/**
 * The template of ember-website's meetups page after the ember-leaflet stage, shortened.
 */
test("the imports of array and hash go, because templates of ember-source 7.4 have them as keywords", () => {
  expect(
    withoutKeywordImports(
      `import { array, hash } from '@ember/helper';
import { fn, hash as h } from "@ember/helper";
import { array as list } from '@ember/helper';

const options = hash;

<template>
  <MapLibreGL @initOptions={{hash center=(array 0 20)}} @x={{fn this.a}} @y={{h}} @z={{list}} />
</template>
`,
      "app/templates/community/meetups/index.gjs",
    ),
  ).toMatchInlineSnapshot(`
    "import { hash } from '@ember/helper';
    import { fn, hash as h } from "@ember/helper";
    import { array as list } from '@ember/helper';

    const options = hash;

    <template>
      <MapLibreGL @initOptions={{hash center=(array 0 20)}} @x={{fn this.a}} @y={{h}} @z={{list}} />
    </template>
    "
  `);
});
