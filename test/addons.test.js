import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { addVitePlugin, removeBuildOptions } from "#config-files.js";
import { Project } from "#project.js";
import { parseProgress, printProgress, readProgress } from "#progress.js";
import emberMetrics from "#stages/addons/ember-metrics.js";
import { emberCliDeploy } from "#stages/addons/removals.js";
import { deprecationWorkflow, emberStyleguide } from "#stages/addons/updates.js";

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

test("ember-styleguide installs from git, and pnpm may build it", async () => {
  let app = project({
    "package.json": `{ "name": "x", "devDependencies": { "ember-styleguide": "^11.3.1" } }`,
    "pnpm-lock.yaml": "",
  });

  await emberStyleguide.run(app);

  expect(emberStyleguide.detect(app)).toBe(false);
  expect(app.dependency("ember-styleguide")).toMatch(
    /^github:NullVoxPopuli-ai-agent\/ember-styleguide#/,
  );
  expect(app.packageJson.pnpm).toEqual({ onlyBuiltDependencies: ["ember-styleguide"] });
  expect(readProgress(app)[0].links).toEqual([
    "https://github.com/ember-learn/ember-styleguide/pull/551",
  ]);
});
