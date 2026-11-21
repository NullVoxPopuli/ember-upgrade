import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import buildSettings from "#stages/build-settings/index.js";

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
 * From rust-lang/crates.io, after the vite stage, shortened.
 */
const BUILD = `'use strict';
const EmberApp = require('ember-cli/lib/broccoli/ember-app');
const { compatBuild } = require('@embroider/compat');

module.exports = async function (defaults) {
  const { buildOnce } = await import('@embroider/vite');

  let env = EmberApp.env();
  let isProd = env === 'production';

  let extraPublicTrees = [];
  if (!isProd) {
    let path = require('node:path');
    let funnel = require('broccoli-funnel');

    let mswPath = require.resolve('msw/mockServiceWorker.js');
    let mswParentPath = path.dirname(mswPath);

    extraPublicTrees.push(funnel(mswParentPath, { include: ['mockServiceWorker.js'] }));
  }

  let app = new EmberApp(defaults, {
    autoImport: {
      webpack: { externals: { moment: 'moment' } },
    },
    babel: {
      plugins: [
        require.resolve('ember-auto-import/babel-plugin'),
        require.resolve('ember-concurrency/async-arrow-task-transform'),
      ],
    },
    sourcemaps: { enabled: true },
  });

  app.import('vendor/qunit.css', { type: 'test' });

  return compatBuild(app, buildOnce, {
    extraPublicTrees,
    staticModifiers: true,
  });
};
`;

test("the ember-cli-build settings move to the places that a Vite build reads", async () => {
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "@embroider/vite": "1.8.1" } }),
    "ember-cli-build.js": BUILD,
    "babel.config.mjs": `export default {
  plugins: [
    ['babel-plugin-ember-template-compilation', {}],
    ...babelCompatSupport(),
  ],
};
`,
    "vendor/qunit.css": ".qunit {}\n",
    "tests/test-helper.js": "import { start } from 'ember-qunit';\n\nstart();\n",
    "node_modules/msw/package.json": JSON.stringify({
      name: "msw",
      exports: { "./mockServiceWorker.js": "./lib/mockServiceWorker.js" },
    }),
    "node_modules/msw/lib/mockServiceWorker.js": "/* worker */\n",
  });

  expect(buildSettings.detect(app)).toBe(true);
  expect((await buildSettings.check(app)).blockers).toEqual([]);
  expect(await buildSettings.run(app)).toEqual([]);

  expect(app.read("ember-cli-build.js")).toBe(`'use strict';
const EmberApp = require('ember-cli/lib/broccoli/ember-app');
const { compatBuild } = require('@embroider/compat');

module.exports = async function (defaults) {
  const { buildOnce } = await import('@embroider/vite');

  let env = EmberApp.env();
  let isProd = env === 'production';

  let app = new EmberApp(defaults, {
    sourcemaps: { enabled: true },
  });

  return compatBuild(app, buildOnce, {
    staticModifiers: true,
  });
};
`);
  expect(app.read("babel.config.mjs")).toBe(`export default {
  plugins: [
    ['babel-plugin-ember-template-compilation', {}],
    'ember-concurrency/async-arrow-task-transform',
    ...babelCompatSupport(),
  ],
};
`);
  expect(app.read("tests/test-helper.js")).toBe(
    "import { start } from 'ember-qunit';\nimport './vendor/qunit.css';\n\nstart();\n",
  );
  expect(app.has("vendor/qunit.css")).toBe(false);
  expect(app.read("tests/vendor/qunit.css")).toBe(".qunit {}\n");
  expect(app.read("public/mockServiceWorker.js")).toBe("/* worker */\n");
  expect(JSON.parse(app.read("package.json")).msw).toEqual({ workerDirectory: ["public"] });
  expect(buildSettings.detect(app)).toBe(false);
});
