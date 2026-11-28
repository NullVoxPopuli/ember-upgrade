import { expect, test } from "vitest";

import { withAddonContentOff } from "#stages/vite/config-module.js";
import { removeDeadTrees } from "#stages/vite/dead-trees.js";
import { withMacrosConfig, withWarpDriveConfig } from "#stages/vite/warp-drive-config.js";

/**
 * From hashicorp-forge/hermes web/ember-cli-build.js, after ember-vite-codemod, with the app options shortened.
 */
test("the code that post-processes app.toTree() goes, with the requires that only it used", () => {
  let source = `"use strict";;
const EmberApp = require("ember-cli/lib/broccoli/ember-app");
const PostcssCompiler = require('broccoli-postcss');
const Funnel = require('broccoli-funnel');
const mergeTrees = require('broccoli-merge-trees');

const {
  compatBuild
} = require("@embroider/compat");

module.exports = async function(defaults) {
  const {
    buildOnce
  } = await import("@embroider/vite");

  const tailwindcss = require('tailwindcss');
  const autoprefixer = require('autoprefixer');

  let app = new EmberApp(defaults, {
    'ember-cli-terser': {
      enabled: process.env.EMBER_ENV === 'production',
    },
  });

  // Get the output tree
  let tree = app.toTree();

  // Post-process just the CSS files with Tailwind
  let cssTree = new Funnel(tree, {
    include: ['assets/*.css'],
    destDir: '.'
  });

  let processedCss = new PostcssCompiler(cssTree, {
    plugins: [
      {
        module: tailwindcss,
        options: require('./tailwind.config.js')
      },
      {
        module: autoprefixer
      }
    ],
    map: false
  });

  // Merge processed CSS back with the rest of the tree
  let otherAssets = new Funnel(tree, {
    exclude: ['assets/*.css']
  });

  return compatBuild(app, buildOnce);
};
`;

  expect(removeDeadTrees(source, "ember-cli-build.js")).toMatchInlineSnapshot(`
    ""use strict";;
    const EmberApp = require("ember-cli/lib/broccoli/ember-app");
    const mergeTrees = require('broccoli-merge-trees');

    const {
      compatBuild
    } = require("@embroider/compat");

    module.exports = async function(defaults) {
      const {
        buildOnce
      } = await import("@embroider/vite");


      let app = new EmberApp(defaults, {
        'ember-cli-terser': {
          enabled: process.env.EMBER_ENV === 'production',
        },
      });





      return compatBuild(app, buildOnce);
    };
    "
  `);
});

test("a build that returns compatBuild with no tree code stays the same", () => {
  let source = `const EmberApp = require("ember-cli/lib/broccoli/ember-app");
const { compatBuild } = require("@embroider/compat");

module.exports = async function (defaults) {
  const { buildOnce } = await import("@embroider/vite");
  let app = new EmberApp(defaults, {});

  return compatBuild(app, buildOnce);
};
`;

  expect(removeDeadTrees(source, "ember-cli-build.js")).toBe(source);
});

/**
 * From ember-learn/ember-website ember-cli-build.js (MIT), after ember-vite-codemod, with the app options shortened.
 * The app built with Embroider and webpack before.
 */
test("a second compatBuild call and its options go, with the requires that only they used", () => {
  let source = `'use strict';;

const { compatBuild } = require('@embroider/compat');
const EmberApp = require('ember-cli/lib/broccoli/ember-app');
const { prerender } = require('prember');

module.exports = async function(defaults) {
  const {
    buildOnce
  } = await import("@embroider/vite");

  const app = new EmberApp(defaults, {
    prember: { urls: ['/', 'teams'] },
  });

  const options = {
    packagerOptions: {
      publicAssetURL: '/',
    },
    staticAddonTrees: true,
  };

  const compiledApp = compatBuild(app, Webpack, options);

  return compatBuild(app, buildOnce);
};
`;

  expect(removeDeadTrees(source, "ember-cli-build.js")).toMatchInlineSnapshot(`
    "'use strict';;

    const { compatBuild } = require('@embroider/compat');
    const EmberApp = require('ember-cli/lib/broccoli/ember-app');
    const { prerender } = require('prember');

    module.exports = async function(defaults) {
      const {
        buildOnce
      } = await import("@embroider/vite");

      const app = new EmberApp(defaults, {
        prember: { urls: ['/', 'teams'] },
      });



      return compatBuild(app, buildOnce);
    };
    "
  `);
});

test("compatBuild gets useAddonConfigModule: false and useAddonAppBoot: false", () => {
  expect(
    withAddonContentOff(
      "module.exports = async function (defaults) {\n  return compatBuild(app, buildOnce);\n};\n",
      "ember-cli-build.js",
    ),
  ).toBe(
    "module.exports = async function (defaults) {\n  return compatBuild(app, buildOnce, { useAddonConfigModule: false });\n};\n",
  );
  expect(
    withAddonContentOff(
      "module.exports = async function (defaults) {\n  return compatBuild(app, buildOnce, { staticAddonTrees: true });\n};\n",
      "ember-cli-build.js",
    ),
  ).toBe(
    "module.exports = async function (defaults) {\n  return compatBuild(app, buildOnce, { useAddonConfigModule: false, staticAddonTrees: true });\n};\n",
  );
  expect(
    withAddonContentOff(
      "module.exports = async function (defaults) {\n  return compatBuild(app, buildOnce, { useAddonConfigModule: false });\n};\n",
      "ember-cli-build.js",
      "useAddonAppBoot",
    ),
  ).toBe(
    "module.exports = async function (defaults) {\n  return compatBuild(app, buildOnce, { useAddonAppBoot: false, useAddonConfigModule: false });\n};\n",
  );
});

/**
 * From ember-learn/deprecation-app ember-cli-build.js, after ember-vite-codemod, shortened.
 */
test("an app on ember-data 5 calls setConfig of @warp-drive/build-config", () => {
  expect(
    withWarpDriveConfig(
      `module.exports = async function (defaults) {
  const { buildOnce } = await import('@embroider/vite');
  let app = new EmberApp(defaults, {});

  return compatBuild(app, buildOnce);
};
`,
      "ember-cli-build.js",
    ),
  ).toMatchInlineSnapshot(`
    "module.exports = async function (defaults) {
      const { buildOnce } = await import('@embroider/vite');
      let app = new EmberApp(defaults, {});
      const { setConfig } = await import('@warp-drive/build-config');
      setConfig(app, __dirname, {});

      return compatBuild(app, buildOnce);
    };
    "
  `);
});

test("a plain function in CommonJS loads setConfig with require", () => {
  expect(
    withWarpDriveConfig(
      `const EmberApp = require('ember-cli/lib/broccoli/ember-app');

module.exports = function (defaults) {
  let app = new EmberApp(defaults, {});

  return app.toTree();
};

async function unrelated() {}
`,
      "ember-cli-build.js",
    ),
  ).toMatchInlineSnapshot(`
    "const EmberApp = require('ember-cli/lib/broccoli/ember-app');

    module.exports = function (defaults) {
      let app = new EmberApp(defaults, {});
      const { setConfig } = require('@warp-drive/build-config');
      setConfig(app, __dirname, {});

      return app.toTree();
    };

    async function unrelated() {}
    "
  `);
});

/**
 * From ember-learn/deprecation-app babel.config.mjs (MIT), shortened.
 */
test("the macros of the Babel config set the config of ember-data 5", () => {
  expect(
    withMacrosConfig(
      `import { buildMacros } from '@embroider/macros/babel';

const macros = buildMacros();

export default { plugins: [...macros.babelMacros] };
`,
      "babel.config.mjs",
    ),
  ).toMatchInlineSnapshot(`
    "import { buildMacros } from '@embroider/macros/babel';
    import { setConfig } from '@warp-drive/build-config';

    const macros = buildMacros({
      configure(config) {
        setConfig(config, {});
      },
    });

    export default { plugins: [...macros.babelMacros] };
    "
  `);
});

test("a configure hook of the macros gets the setConfig call", () => {
  expect(
    withMacrosConfig(
      `const { buildMacros } = require('@embroider/macros/babel');

const macros = buildMacros({
  configure(config) {
    config.enableRuntimeMode();
  },
});
`,
      "babel.config.cjs",
    ),
  ).toMatchInlineSnapshot(`
    "const { setConfig } = require('@warp-drive/build-config');
    const { buildMacros } = require('@embroider/macros/babel');

    const macros = buildMacros({
      configure(config) {
        setConfig(config, {});
        config.enableRuntimeMode();
      },
    });
    "
  `);
});
