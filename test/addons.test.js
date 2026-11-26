import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { addVitePlugin, removeBuildOptions } from "#config-files.js";
import { Project } from "#project.js";
import { parseProgress, printProgress, readProgress } from "#progress.js";
import emberMetrics from "#stages/addons/ember-metrics.js";
import { rewriteClickOutside } from "#stages/addons/click-outside.js";
import inlineContent from "#stages/addons/inline-content.js";
import { replaceTypeahead } from "#stages/addons/power-select-typeahead.js";
import {
  addBasicDropdownWormhole,
  optionClasses,
  rewritePowerSelectMultiple,
  updatePowerSelect,
  withOptionClicks,
} from "#stages/addons/power-select.js";
import { emberCliDeploy, obsoleteAddons } from "#stages/addons/removals.js";
import { commonJsToEsm, emberCliHead } from "#stages/addons/inline.js";
import { iconsModule, rewriteDynamicIcons } from "#stages/addons/svg-jar-icons.js";
import {
  deprecationWorkflow,
  emberStyleguide,
  emberStyleguideCss,
} from "#stages/addons/updates.js";

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

/**
 * From ember-learn/ember-api-docs, after the vite stage.
 */
const API_DOCS_BUILD = `'use strict';

const EmberApp = require('ember-cli/lib/broccoli/ember-app');
const envIsProduction = process.env.EMBER_ENV === 'production';

module.exports = async function (defaults) {
  const app = new EmberApp(defaults, {
    fingerprint: {
      extensions: ['js', 'css', 'jpg', 'png', 'gif', 'map', 'webmanifest'],
      generateAssetMap: true,
    },
    autoprefixer: {
      enabled: true,
      cascade: true,
      sourcemap: !envIsProduction,
      overrideBrowsersList: ['default'],
    },
    'asset-cache': {
      version: '4', //Might have to change this with the app build,
    },
    svgJar: {
      sourceDirs: ['public/assets/images'],
    },
  });

  return compatBuild(app, buildOnce);
};
`;

test("build options go with their lines, and the other options stay as they are", () => {
  let app = project({ "ember-cli-build.js": API_DOCS_BUILD });

  expect(removeBuildOptions(app, ["autoprefixer", "svgJar"])).toEqual(["autoprefixer", "svgJar"]);
  expect(app.read("ember-cli-build.js")).toBe(`'use strict';

const EmberApp = require('ember-cli/lib/broccoli/ember-app');
const envIsProduction = process.env.EMBER_ENV === 'production';

module.exports = async function (defaults) {
  const app = new EmberApp(defaults, {
    fingerprint: {
      extensions: ['js', 'css', 'jpg', 'png', 'gif', 'map', 'webmanifest'],
      generateAssetMap: true,
    },
    'asset-cache': {
      version: '4', //Might have to change this with the app build,
    },
  });

  return compatBuild(app, buildOnce);
};
`);
});

test("a plugin goes at the end of the plugins array of the Vite config", () => {
  let app = project({
    "vite.config.mjs": `import { defineConfig } from 'vite';
import { extensions, classicEmberSupport, ember } from '@embroider/vite';
import { babel } from '@rollup/plugin-babel';

export default defineConfig({
  plugins: [
    classicEmberSupport(),
    ember(),
    // extra plugins here
    babel({
      babelHelpers: 'runtime',
      extensions,
    }),
  ],
});
`,
  });
  let plugin = {
    specifier: "@svg-jar/plugin/vite",
    importLine: "import svgJar from '@svg-jar/plugin/vite';",
    call: "svgJar({ target: 'ember' })",
  };

  expect(addVitePlugin(app, plugin)).toBe(true);
  expect(addVitePlugin(app, plugin)).toBe(true);
  expect(app.read("vite.config.mjs")).toBe(`import { defineConfig } from 'vite';
import { extensions, classicEmberSupport, ember } from '@embroider/vite';
import { babel } from '@rollup/plugin-babel';
import svgJar from '@svg-jar/plugin/vite';

export default defineConfig({
  plugins: [
    classicEmberSupport(),
    ember(),
    // extra plugins here
    babel({
      babelHelpers: 'runtime',
      extensions,
    }),
    svgJar({ target: 'ember' }),
  ],
});
`);
});

test("the progress file reads back what it wrote", () => {
  let entries = [
    {
      id: "ember-styleguide",
      status: "git-ref",
      note: 'A "quoted" note: with a colon',
      links: ["https://a.example/1"],
    },
    { id: "@percy/ember", status: "v1-addon", note: "No links" },
  ];

  expect(parseProgress(printProgress(entries))).toEqual(entries);
});

test("ember-metrics adapters move from config/environment.js to the application route", async () => {
  let app = project({
    "package.json": `{\n  "name": "ember-api-docs",\n  "devDependencies": {\n    "ember-metrics": "^2.0.0",\n    "ember-source": "~6.7.0"\n  }\n}\n`,
    "app/metrics-adapters/local-adapter.js": "export default class LocalAdapter {}\n",
    "config/environment.js": `'use strict';

module.exports = function (environment) {
  const ENV = {
    modulePrefix: 'ember-api-docs',
    environment,

    metricsAdapters: [
      {
        name: 'GoogleAnalytics',
        environments: ['production'],
        config: {
          id: 'UA-27675533-1',
        },
      },
      {
        name: 'LocalAdapter',
        environments: ['development'],
      },
    ],
  };

  return ENV;
};
`,
    "app/routes/application.js": `import { service } from '@ember/service';
import Route from '@ember/routing/route';
import ENV from 'ember-api-docs/config/environment';

export default class ApplicationRoute extends Route {
  @service
  router;

  @service
  metrics;

  constructor() {
    super(...arguments);
    this.router.on('routeDidChange', this.trackPage);
  }
}
`,
  });

  expect(emberMetrics.detect(app)).toBe(true);
  expect(await emberMetrics.run(app)).toEqual([]);
  expect(emberMetrics.detect(app)).toBe(false);
  expect(app.dependency("ember-metrics")).toBe("^3.0.0");
  expect(app.read("config/environment.js")).toBe(`'use strict';

module.exports = function (environment) {
  const ENV = {
    modulePrefix: 'ember-api-docs',
    environment,

  };

  return ENV;
};
`);
  expect(app.read("app/routes/application.js")).toBe(`import { service } from '@ember/service';
import Route from '@ember/routing/route';
import ENV from 'ember-api-docs/config/environment';
import GoogleAnalytics from 'ember-metrics/metrics-adapters/google-analytics';
import LocalAdapter from '../metrics-adapters/local-adapter';

export default class ApplicationRoute extends Route {
  @service
  router;

  @service
  metrics;

  constructor() {
    super(...arguments);

    this.metrics.appEnvironment = ENV.environment;
    this.metrics.activateAdapters([
      {
        name: 'GoogleAnalytics',
        adapter: GoogleAnalytics,
        environments: ['production'],
        config: {
          id: 'UA-27675533-1',
        },
      },
      {
        name: 'LocalAdapter',
        adapter: LocalAdapter,
        environments: ['development'],
      },
    ]);
    this.router.on('routeDidChange', this.trackPage);
  }
}
`);
});

test("ember-metrics config that reads variables is left for the user", async () => {
  let app = project({
    "package.json": `{ "name": "x", "devDependencies": { "ember-metrics": "^1.0.0" } }`,
    "config/environment.js": `module.exports = function (environment) {
  let id = process.env.GA_ID;
  return { metricsAdapters: [{ name: 'GoogleAnalytics', config: { id } }] };
};
`,
  });
  let before = app.read("config/environment.js");
  let todo = await emberMetrics.run(app);

  expect(todo.map((item) => item.title)).toEqual([
    "Activate the ember-metrics adapters in the application route",
  ]);
  expect(app.read("config/environment.js")).toBe(before);
});

test("ember-cli-deploy goes, with its config, and the progress file says how to deploy", async () => {
  let app = project({
    "package.json": `{
  "name": "x",
  "scripts": { "deploy": "ember deploy production" },
  "devDependencies": {
    "ember-cli-deploy": "^2.0.0",
    "ember-cli-deploy-build": "^3.0.0",
    "ember-cli-deploy-gzip": "^3.0.0",
    "ember-source": "~6.7.0"
  }
}
`,
    "config/deploy.js": "module.exports = function () {};\n",
  });

  let todo = await emberCliDeploy.run(app);

  expect(app.packageJson.devDependencies).toEqual({ "ember-source": "~6.7.0" });
  expect(app.has("config/deploy.js")).toBe(false);
  expect(todo[0].where).toEqual(["package.json scripts.deploy: ember deploy production"]);
  expect(readProgress(app).map((entry) => entry.id)).toEqual(["ember-cli-deploy"]);
});

test("deprecation-workflow v4 is imported first in app.js", async () => {
  let app = project({
    "package.json": `{ "name": "x", "devDependencies": { "ember-cli-deprecation-workflow": "^3.4.0" } }`,
    "app/deprecation-workflow.js":
      "import setupDeprecationWorkflow from 'ember-cli-deprecation-workflow';\n",
    "app/app.js": "import Application from '@ember/application';\n",
  });

  await deprecationWorkflow.run(app);

  expect(app.dependency("ember-cli-deprecation-workflow")).toBe("^4.0.1");
  expect(app.read("app/app.js")).toBe(
    "import './deprecation-workflow';\nimport Application from '@ember/application';\n",
  );
});

test("ember-styleguide installs from git, and pnpm 10 may build it", async () => {
  let app = project({
    "package.json": `{ "name": "x", "packageManager": "pnpm@10.28.0", "devDependencies": { "ember-styleguide": "^11.3.1" } }`,
    "pnpm-lock.yaml": "",
  });

  await emberStyleguide.run(app);

  expect(emberStyleguide.detect(app)).toBe(false);
  expect(app.dependency("ember-styleguide")).toMatch(
    /^github:NullVoxPopuli-ai-agent\/ember-styleguide#/,
  );
  expect(app.read("pnpm-workspace.yaml")).toBe("onlyBuiltDependencies:\n  - ember-styleguide\n");
  expect(readProgress(app)[0].links).toEqual([
    "https://github.com/ember-learn/ember-styleguide/pull/551",
  ]);
});

test("pnpm 11 and later read allowBuilds from pnpm-workspace.yaml, by the tarball URL for a git-hosted package", async () => {
  let app = project({
    "package.json": `{ "name": "x", "packageManager": "pnpm@12.21.0", "devDependencies": { "ember-styleguide": "^11.3.1" } }`,
    "pnpm-lock.yaml": "",
    "pnpm-workspace.yaml": "allowBuilds:\n  esbuild: true\n",
  });

  await emberStyleguide.run(app);

  expect(app.read("pnpm-workspace.yaml")).toMatchInlineSnapshot(`
    "allowBuilds:
      esbuild: true
      ember-styleguide: true
      'ember-styleguide@https://codeload.github.com/NullVoxPopuli-ai-agent/ember-styleguide/tar.gz/a00373bc5bf1a9f125545c6ed470294cf86bc907': true
    "
  `);
  expect(app.packageJson.pnpm).toBeUndefined();
});

/**
 * From rust-lang/crates.io, after the template-tag stage, shortened.
 */
const STATS_VALUE = `import scopedClass from 'ember-scoped-css/helpers/scoped-class';
import svgJar from 'ember-svg-jar/helpers/svg-jar';

<template>
  <div ...attributes class='stats-value'>
    {{svgJar @icon role='img' aria-hidden='true' class=(scopedClass 'icon')}}
  </div>
</template>
`;

test("an icon name that is only known at runtime becomes a lookup in the icon map", () => {
  expect(rewriteDynamicIcons(STATS_VALUE, "app/components/stats-value.gjs")).toBe(
    `import scopedClass from 'ember-scoped-css/helpers/scoped-class';
import svgJarIcon from '../utils/svg-jar-icons.js';

<template>
  <div ...attributes class='stats-value'>
    {{#let (svgJarIcon @icon) as |SvgJarIcon|}}<SvgJarIcon role='img' aria-hidden='true' class={{scopedClass 'icon'}} />{{/let}}
  </div>
</template>
`,
  );
});

test("the svgJar import stays for the codemod when the file also has static icons", () => {
  let source = `import svgJar from 'ember-svg-jar/helpers/svg-jar';

<template>
  {{svgJar 'github'}}
  {{svgJar (if @open 'chevron-up' 'chevron-down')}}
</template>
`;

  expect(rewriteDynamicIcons(source, "app/components/toggle.gjs")).toBe(
    `import svgJar from 'ember-svg-jar/helpers/svg-jar';
import svgJarIcon from '../utils/svg-jar-icons.js';

<template>
  {{svgJar 'github'}}
  {{#let (svgJarIcon (if @open 'chevron-up' 'chevron-down')) as |SvgJarIcon|}}<SvgJarIcon />{{/let}}
</template>
`,
  );
});

test("a file with only static icons is left to the codemod", () => {
  expect(
    rewriteDynamicIcons("<template>{{svgJar 'github'}}</template>\n", "app/components/a.gjs"),
  ).toBeUndefined();
});

test("the icon map names each icon by its file name, as ember-svg-jar does", () => {
  let app = project({
    "ember-cli-build.js": "module.exports = function () {};\n",
    "public/assets/github.svg": "<svg></svg>",
    "public/assets/brands/rust-logo.svg": "<svg></svg>",
  });

  expect(iconsModule(app)).toBe(`/**
 * Each icon that ember-svg-jar found by name, for templates that pick the icon at runtime.
 * A caller that passes the component instead of a name does not need this map.
 */
import RustLogo from '../../public/assets/brands/rust-logo.svg?unsafe-inline';
import Github from '../../public/assets/github.svg?unsafe-inline';

const ICONS = {
  "rust-logo": RustLogo,
  "github": Github,
};

/**
 * @param {string} name
 */
export default function svgJarIcon(name) {
  return ICONS[name];
}
`);
});

test("a small v1 addon moves into the app, and its imports follow", async () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: { "ember-cli-head": "2.0.0", "ember-source": "7.4.0" },
    }),
    "app/templates/head.hbs": "<meta name='description' content={{this.model.description}}>\n",
    "app/templates/application.gjs":
      "import HeadLayout from 'ember-cli-head/components/head-layout';\n\n<template><HeadLayout /></template>\n",
  });

  expect((await emberCliHead.check(app)).blockers).toEqual([]);

  await emberCliHead.run(app);

  expect(app.read("app/templates/application.gjs")).toBe(
    "import HeadLayout from '../components/head-layout.gjs';\n\n<template><HeadLayout /></template>\n",
  );
  expect(app.has("app/templates/head.hbs")).toBe(false);
  expect(app.read("app/components/head-content.hbs")).toBe(
    "<meta name='description' content={{this.model.description}}>\n",
  );
  expect(app.has("app/services/head-data.js")).toBe(true);

  let own = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-cli-head": "2.0.0" } }),
    "app/templates/head.hbs": "<meta>\n",
    "app/services/head-data.js": "export default class HeadDataService {}\n",
  });

  expect((await emberCliHead.check(own)).blockers).toEqual([]);

  await emberCliHead.run(own);

  expect(own.read("app/services/head-data.js")).toBe("export default class HeadDataService {}\n");
  expect(app.dependency("ember-cli-head")).toBeUndefined();
});

test("CommonJS that only assigns exports becomes an ES module", () => {
  expect(
    commonJsToEsm(`"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * import macro from 'macro-decorators';
 */
function macro(fn) {
  return fn;
}
exports.default = macro;
function alias(key) {
  return key;
}
exports.alias = alias;
`),
  ).toMatchInlineSnapshot(`
    "/**
     * import macro from 'macro-decorators';
     */
    function macro(fn) {
      return fn;
    }
    export default macro;
    function alias(key) {
      return key;
    }
    export { alias };
    "
  `);

  expect(commonJsToEsm(`module.exports = function () {};\n`)).toBeUndefined();
});

/**
 * From code-corps/code-corps-ember (MIT), after the vite stage, shortened.
 */
test("the obsolete addons go, and a shim leaves the library that it wrapped", async () => {
  let app = project({
    "package.json": JSON.stringify({
      name: "x",
      devDependencies: {
        "ember-cli-moment-shim": "^3.0.1",
        "ember-cli-shims": "1.1.0",
        "ember-normalize": "1.0.0",
        moment: "^2.18.1",
        "normalize.css": "^7.0.0",
      },
    }),
    "app/app.js": "import Application from '@ember/application';\n",
    "app/styles/app.scss": '@import "normalize.css/normalize";\n',
  });
  let stages = await obsoleteAddons.expand(app);
  let ran = [];

  for (let stage of stages) {
    if (!stage.detect(app)) continue;

    await stage.run(app);
    ran.push(stage.name);
  }

  expect(ran).toEqual(["ember-cli-shims", "ember-cli-moment-shim", "ember-normalize"]);
  expect(app.packageJson.devDependencies).toEqual({
    moment: "^2.18.1",
    "normalize.css": "^7.0.0",
  });
  expect(app.read("app/app.js")).toBe("import Application from '@ember/application';\n");
});

test("without ember-normalize, the app imports normalize.css", async () => {
  let app = project({
    "package.json": JSON.stringify({
      name: "x",
      devDependencies: { "ember-normalize": "1.0.0", "normalize.css": "^7.0.0" },
    }),
    "app/app.js": "import Application from '@ember/application';\n",
  });
  let stage = (await obsoleteAddons.expand(app)).find((entry) => entry.name === "ember-normalize");

  await stage?.run(app);

  expect(app.read("app/app.js")).toBe(
    "import \"normalize.css\";\nimport Application from '@ember/application';\n",
  );
});

/**
 * From code-corps/code-corps-ember (MIT), shortened.
 */
test("the click-outside component becomes the on-click-outside modifier on a div", () => {
  expect(
    rewriteClickOutside(`{{#click-outside action=(fn (mut this.showDropdown) false)}}
  <button>Status</button>
{{/click-outside}}
<ClickOutside @onClickOutside={{this.hide}} @exceptSelector=".trigger" class="menu">
  {{yield}}
</ClickOutside>
`),
  ).toMatchInlineSnapshot(`
    {
      "template": "<div {{on-click-outside (fn (mut this.showDropdown) false)}}>
      <button>Status</button>
    </div>
    <div class="menu" {{on-click-outside this.hide exceptSelector=".trigger"}}>
      {{yield}}
    </div>
    ",
      "unreadable": [],
    }
  `);
});

test("a click-outside with an action name stays", () => {
  expect(
    rewriteClickOutside(`{{#click-outside action="hide"}}x{{/click-outside}}`).unreadable,
  ).toEqual(["click-outside with action=", "click-outside without a callback"]);
});

/**
 * From emberobserver/client (MIT), after the vite stage, shortened.
 */
test("the classic decorator and the percy snapshots go with their addons", async () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: { "ember-classic-decorator": "^1.0.8", "ember-percy": "^1.6.0" },
    }),
    "app/routes/admin.js": `import classic from 'ember-classic-decorator';
import Route from '@ember/routing/route';

@classic
export default class AdminRoute extends Route {}
`,
    "tests/acceptance/index-test.js": `import { visit } from '@ember/test-helpers';
import { percySnapshot } from 'ember-percy';

test('index', async function () {
  await visit('/');
  await percySnapshot('/index');
});
`,
  });

  for (let stage of await obsoleteAddons.expand(app)) {
    if (stage.detect(app)) await stage.run(app);
  }

  expect(app.read("app/routes/admin.js")).toMatchInlineSnapshot(`
    "import Route from '@ember/routing/route';

    export default class AdminRoute extends Route {}
    "
  `);
  expect(app.read("tests/acceptance/index-test.js")).toMatchInlineSnapshot(`
    "import { visit } from '@ember/test-helpers';

    test('index', async function () {
      await visit('/');
    });
    "
  `);
});

/**
 * From emberobserver/client (MIT), after the vite stage, shortened.
 */
test("the snippets of ember-cli-inline-content go into index.html", async () => {
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-cli-inline-content": "^0.4.1" } }),
    "ember-cli-build.js": `'use strict';
const EmberApp = require('ember-cli/lib/broccoli/ember-app');
const parseFlag = require('./config/parse-flag');
const env = EmberApp.env();
const broccoliAssetRevDefaults = require('broccoli-asset-rev/lib/default-options');

module.exports = async function (defaults) {
  let options = {
    inlineContent: {},
    fingerprint: {
      extensions: broccoliAssetRevDefaults.extensions.concat(['svg']),
    },
  };

  if (parseFlag('FAVICON', true)) {
    options.inlineContent['snippets/favicon'] = 'app/snippets/favicon.html';
  }

  if (parseFlag('REPORT_ERRORS', env === 'production')) {
    options.inlineContent['snippets/trackjs'] = 'app/snippets/trackjs.html';
  }

  options.inlineContent['snippets/perf-utils'] = 'app/snippets/perf-utils.js';

  options.fingerprint.enabled = parseFlag('FINGERPRINT', env === 'production');

  let app = new EmberApp(defaults, options);

  return app.toTree();
};
`,
    "app/snippets/favicon.html": '<link rel="icon" href="/favicon.png">\n',
    "app/snippets/trackjs.html": '<script src="https://cdn.trackjs.com/agent.js"></script>\n',
    "app/snippets/perf-utils.js": "window.performance = window.performance || {};\n",
    "index.html": `<head>
    {{content-for "snippets/perf-utils"}}
    {{content-for "snippets/favicon"}}
    {{content-for "snippets/trackjs"}}
</head>
`,
  });

  await inlineContent.run(app);
  removeBuildOptions(app, ["fingerprint"]);

  expect(app.read("index.html")).toMatchInlineSnapshot(`
    "<head>
        <script>
        window.performance = window.performance || {};
        </script>
        <link rel="icon" href="/favicon.png">
    </head>
    "
  `);
  expect(app.read("ember-cli-build.js")).toMatchInlineSnapshot(`
    "'use strict';
    const EmberApp = require('ember-cli/lib/broccoli/ember-app');
    const env = EmberApp.env();

    module.exports = async function (defaults) {
      let options = {};

      let app = new EmberApp(defaults, options);

      return app.toTree();
    };
    "
  `);
  expect(app.files(["app/**"])).toMatchInlineSnapshot(`
    [
      "app",
      "app/snippets",
      "app/snippets/trackjs.html",
    ]
  `);
  expect(readProgress(app).map((entry) => entry.id)).toEqual(["ember-cli-inline-content"]);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("the typeahead becomes a power select with the search field in the trigger", () => {
  expect(
    replaceTypeahead(
      `import Component from '@glimmer/component';
import PowerSelectTypeahead from "ember-power-select-typeahead/components/power-select-typeahead";

export default class PageLayout extends Component {
  <template>
    <PowerSelectTypeahead @search={{this.search}} @onChange={{this.go}} as |name|>
      {{name}}
    </PowerSelectTypeahead>
  </template>
}
`,
      "app/components/page-layout.gjs",
    ),
  ).toMatchInlineSnapshot(`
    "import Component from '@glimmer/component';
    import PowerSelect from "ember-power-select/components/power-select";

    export default class PageLayout extends Component {
      <template>
        <PowerSelect @searchEnabled={{true}} @searchFieldPosition="trigger" @search={{this.search}} @onChange={{this.go}} as |name|>
          {{name}}
        </PowerSelect>
      </template>
    }
    "
  `);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("power-select-multiple becomes power-select with multiple", () => {
  expect(
    rewritePowerSelectMultiple(`{{#power-select-multiple options=this.categories onChange=this.pick as |category|}}
  {{category.name}}
{{/power-select-multiple}}
<PowerSelectMultiple @options={{this.tags}} as |tag|>{{tag}}</PowerSelectMultiple>
`).template,
  ).toMatchInlineSnapshot(`
    "{{#power-select multiple=true options=this.categories onChange=this.pick as |category|}}
      {{category.name}}
    {{/power-select}}
    <PowerSelect @multiple={{true}} @options={{this.tags}} as |tag|>{{tag}}</PowerSelect>
    "
  `);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("selectChoose comes from the test-support entry of ember-power-select 9", () => {
  expect(
    updatePowerSelect(
      `import { selectChoose, clickTrigger } from 'ember-power-select/test-support/helpers';\n`,
      "tests/acceptance/header-search-test.js",
    ).template,
  ).toMatchInlineSnapshot(`
    "import { clickTrigger } from 'ember-power-select/test-support/helpers';
    import { selectChoose } from 'ember-power-select/test-support';
    "
  `);
});

/**
 * From TryGhost/Ghost ghost/admin/app/components/power-select-vertical-collection-options.hbs (MIT), shortened, with a call of the `-present` helper added.
 */
test("ember-power-select-is-selected is ember-power-select-is-equal in ember-power-select 8 and later", () => {
  expect(
    updatePowerSelect(
      `{{#vertical-collection @options minHeight=30 as |opt index|}}
    <li class="ember-power-select-option"
        aria-selected="{{ember-power-select-is-selected opt @select.selected}}"
        {{ember-power-select-is-selected-present}}>
    </li>
{{/vertical-collection}}
`,
      "app/components/power-select-vertical-collection-options.hbs",
    ),
  ).toMatchInlineSnapshot(`
    {
      "template": "{{#vertical-collection @options minHeight=30 as |opt index|}}
        <li class="ember-power-select-option"
            aria-selected="{{ember-power-select-is-equal opt @select.selected}}"
            {{ember-power-select-is-selected-present}}>
        </li>
    {{/vertical-collection}}
    ",
      "unreadable": [],
    }
  `);
  expect(
    updatePowerSelect(
      `import { emberPowerSelectIsSelected } from 'ember-power-select/helpers/ember-power-select-is-selected';\n`,
      "app/utils/x.js",
    ).unreadable,
  ).toHaveLength(1);
});

test("the application template gets the wormhole of ember-basic-dropdown", () => {
  let app = project({
    "package.json": "{}",
    "app/templates/application.hbs": "<main>{{outlet}}</main>\n",
  });

  addBasicDropdownWormhole(app);
  addBasicDropdownWormhole(app);

  expect(app.read("app/templates/application.hbs")).toBe(
    "<main>{{outlet}}</main>\n<BasicDropdownWormhole />\n",
  );
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("code that read window.moment imports moment when the shim goes", async () => {
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-cli-moment-shim": "^3.8.0" } }),
    "tests/acceptance/code-search-test.js": "let date = window.moment().subtract(2, 'days');\n",
  });
  let stage = (await obsoleteAddons.expand(app)).find(
    (entry) => entry.name === "ember-cli-moment-shim",
  );

  await stage?.run(app);

  expect(app.read("tests/acceptance/code-search-test.js")).toBe(
    "import moment from 'moment';\nlet date = moment().subtract(2, 'days');\n",
  );
});

/**
 * The template and the test are from emberobserver/client, shortened.
 */
test("a click on an element in a power-select option sends only the click event", () => {
  let app = project({
    "app/components/page-layout.hbs": `<PowerSelect @search={{perform this.searchForAddons}} as |addonName options|>
  {{#if addonName.isFullSearchLink}}
    <LinkTo @route="index" class="jump-to-full-search test-search-result-jump-to-full-search-link">Search</LinkTo>
  {{else}}
    <LinkTo @route="addons.show" @model={{addonName}} class="test-search-result-addon-link">{{addonName}}</LinkTo>
  {{/if}}
</PowerSelect>
<button class="test-logout" type="button">Log out</button>
`,
  });

  expect(
    withOptionClicks(
      `import { click, fillIn, currentURL } from '@ember/test-helpers';

test('Each option is also a link to where it would go', async function (assert) {
  await fillIn('.test-header-search input', 'test');

  await click(findByText('.test-search-result-addon-link', 'addon-test'));

  await click('.test-search-result-jump-to-full-search-link');

  await click('.test-logout');
});
`,
      "tests/acceptance/header-search-test.js",
      optionClasses(app),
    ),
  ).toMatchInlineSnapshot(`
    "import { click, fillIn, currentURL, triggerEvent } from '@ember/test-helpers';

    test('Each option is also a link to where it would go', async function (assert) {
      await fillIn('.test-header-search input', 'test');

      /** click() renders between mouseup and click. PowerSelect closes on mouseup, so a full click reaches a removed element. */
      await triggerEvent(findByText('.test-search-result-addon-link', 'addon-test'), 'click');

      /** click() renders between mouseup and click. PowerSelect closes on mouseup, so a full click reaches a removed element. */
      await triggerEvent('.test-search-result-jump-to-full-search-link', 'click');

      await click('.test-logout');
    });
    "
  `);
});

/**
 * From ember-learn/upgrade-guide app/app.js, shortened.
 */
test("an app on Vite imports the CSS of the v2 ember-styleguide, before its own stylesheets", async () => {
  let app = project({
    "package.json": `{ "name": "x", "devDependencies": { "@embroider/vite": "^1.7.2", "ember-styleguide": "^11.0.0" } }`,
    "package-lock.json": "{}",
    "app/app.js": `import Application from '@ember/application';
import Resolver from 'ember-resolver';
import './styles/app.css';

export default class App extends Application {}
`,
  });

  await emberStyleguide.run(app);
  await emberStyleguide.run(app);

  expect(app.read("app/app.js")).toMatchInlineSnapshot(`
    "import Application from '@ember/application';
    import Resolver from 'ember-resolver';
    import 'ember-styleguide/styles.css';
    import './styles/app.css';

    export default class App extends Application {}
    "
  `);
});

test("a classic app imports the CSS of the v2 ember-styleguide after the vite stage", async () => {
  let app = project({
    "package.json": `{ "name": "x", "devDependencies": { "ember-styleguide": "^11.0.0" } }`,
    "package-lock.json": "{}",
    "app/app.js": "import './styles/app.css';\n",
  });

  await emberStyleguide.run(app);

  expect(app.read("app/app.js")).toBe("import './styles/app.css';\n");
  expect(emberStyleguideCss.detect(app)).toBe(false);

  app.write(
    "package.json",
    JSON.stringify(
      Object.assign(app.packageJson, {
        devDependencies: Object.assign({}, app.packageJson.devDependencies, {
          "@embroider/vite": "^1.7.2",
        }),
      }),
    ),
  );

  expect(emberStyleguideCss.detect(app)).toBe(true);

  await emberStyleguideCss.run(app);

  expect(app.read("app/app.js")).toBe(
    "import 'ember-styleguide/styles.css';\nimport './styles/app.css';\n",
  );
  expect(emberStyleguideCss.detect(app)).toBe(false);
});
