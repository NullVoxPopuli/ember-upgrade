import { expect, test } from "vitest";

import { removeDeadTrees } from "#stages/vite/dead-trees.js";

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
