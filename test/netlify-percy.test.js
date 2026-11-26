import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import netlify from "#stages/addons/netlify.js";
import { percyHelper } from "#stages/addons/percy.js";

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
 * From ember-learn/ember-help-wanted, with a redirect in the ember-cli-netlify option added.
 */
test("the files of ember-cli-netlify move to public/, with the redirects of its option", async () => {
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-cli-netlify": "^0.4.1" } }),
    ".netlifyredirects": "/*    /index.html   200\n",
    "ember-cli-build.js": `module.exports = function (defaults) {
  const app = new EmberApp(defaults, {
    'ember-cli-netlify': {
      redirects: ['/old /new 301'],
    },
  });
};
`,
  });

  expect(await netlify.run(app)).toEqual([]);
  expect(app.read("public/_redirects")).toMatchInlineSnapshot(`
    "/*    /index.html   200
    /old /new 301
    "
  `);
  expect(existsSync(join(app.directory, ".netlifyredirects"))).toBe(false);
  expect(app.read("ember-cli-build.js")).toMatchInlineSnapshot(`
    "module.exports = function (defaults) {
      const app = new EmberApp(defaults, {});
    };
    "
  `);
  expect(netlify.detect(app)).toBe(false);
});

/**
 * The first lines of addon-test-support/@percy/ember/index.js from @percy/ember 5.0.1 (MIT).
 */
test("the Percy test helper gets its version without the module that the addon's build wrote", () => {
  expect(
    percyHelper(
      `import utils from '@percy/sdk-utils';
import { VERSION as emberVersion } from '@ember/version';
import SDKENV from '@percy/ember/env';

// Collect client and environment information
const CLIENT_INFO = \`@percy/ember/\${SDKENV.VERSION}\`;
`,
      "5.0.1",
    ),
  ).toMatchInlineSnapshot(`
    "import utils from '@percy/sdk-utils';
    import { VERSION as emberVersion } from '@ember/version';
    const SDKENV = { VERSION: "5.0.1", PERCY_SERVER_ADDRESS: undefined };

    // Collect client and environment information
    const CLIENT_INFO = \`@percy/ember/\${SDKENV.VERSION}\`;
    "
  `);
});
