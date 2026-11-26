import { expect, test } from "vitest";

import { contentModule } from "#stages/static-site-json/index.js";

/**
 * From ember-learn/upgrade-guide lib/content-generator/index.js, shortened.
 */
test("an in-repo addon that merges broccoli-static-site-json trees becomes a Vite plugin module", () => {
  expect(
    contentModule(`'use strict';
// eslint-disable-next-line n/no-unpublished-require
const StaticSiteJson = require('broccoli-static-site-json');
// eslint-disable-next-line n/no-unpublished-require
const MergeTrees = require('broccoli-merge-trees');

const EMBERJS_JSON = new StaticSiteJson('source/ember-js-changes', {
  attributes: ['version', 'changes'],
  collate: true,
  contentFolder: '/api/ember-js-changes',
  type: 'ember-js-change',
});

module.exports = {
  name: require('./package').name,

  isDevelopingAddon() {
    return true;
  },

  treeForPublic() {
    return MergeTrees([EMBERJS_JSON]);
  },
};
`),
  ).toMatchInlineSnapshot(`
    "import { StaticSiteJson, staticSiteJson } from "./static-site-json.mjs";

    const EMBERJS_JSON = new StaticSiteJson('source/ember-js-changes', {
      attributes: ['version', 'changes'],
      collate: true,
      contentFolder: '/api/ember-js-changes',
      type: 'ember-js-change',
    });

    export default staticSiteJson([EMBERJS_JSON]);
    "
  `);
});

/**
 * From ember-learn/deprecation-app lib/content-docs-generator/index.js, shortened.
 */
test("trees that map() makes, and a spread of them, stay the app's code", () => {
  expect(
    contentModule(`'use strict';

const StaticSiteJson = require('broccoli-static-site-json');
const BroccoliMergeTrees = require('broccoli-merge-trees');

const contentFolders = ['ember/v1', 'ember-data/v5'];

const jsonTrees = contentFolders.map(
  (type) =>
    new StaticSiteJson(\`content/\${type}\`, {
      type: 'contents',
      collate: true,
      collationFileName: \`\${type.replace(/\\//, '-')}.x.json\`,
    })
);

module.exports = {
  name: 'content-docs-generator',

  treeForPublic() {
    return new BroccoliMergeTrees([...jsonTrees]);
  },
};
`),
  ).toMatchInlineSnapshot(`
    "import { StaticSiteJson, staticSiteJson } from "./static-site-json.mjs";

    const contentFolders = ['ember/v1', 'ember-data/v5'];

    const jsonTrees = contentFolders.map(
      (type) =>
        new StaticSiteJson(\`content/\${type}\`, {
          type: 'contents',
          collate: true,
          collationFileName: \`\${type.replace(/\\//, '-')}.x.json\`,
        })
    );

    export default staticSiteJson([...jsonTrees]);
    "
  `);
});

test("an addon with other code or hooks stays", () => {
  expect(
    contentModule(`const StaticSiteJson = require('broccoli-static-site-json');
const path = require('path');

module.exports = {
  name: 'x',
  treeForPublic() {
    return new StaticSiteJson(path.join(__dirname, 'docs'));
  },
};
`),
  ).toBeUndefined();
  expect(
    contentModule(`const StaticSiteJson = require('broccoli-static-site-json');

module.exports = {
  name: 'x',
  included() {},
  treeForPublic() {
    return new StaticSiteJson('docs');
  },
};
`),
  ).toBeUndefined();
});
