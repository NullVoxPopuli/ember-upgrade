import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import emberCliSass from "#stages/addons/ember-cli-sass.js";

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
 * From code-corps/code-corps-ember, shortened.
 */
test("ember-cli-sass compiles with sass instead of node-sass", async () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: { "ember-cli-sass": "7.0.0", "node-sass": "^4.5.3" },
    }),
    "ember-cli-build.js": `module.exports = function (defaults) {
  let app = new EmberApp(defaults, {
    sassOptions: { implementation: require('node-sass'), includePaths: ['app/styles'] },
  });
};
`,
  });

  expect(emberCliSass.detect(app)).toBe(true);

  await emberCliSass.run(app);

  let { devDependencies } = JSON.parse(app.read("package.json"));

  expect({
    "ember-cli-sass": devDependencies["ember-cli-sass"].replace(/\d+\.\d+\.\d+/, "x"),
    "node-sass": devDependencies["node-sass"],
    sass: devDependencies.sass.replace(/\d+\.\d+\.\d+/, "x"),
    "ember-cli-build.js": app.read("ember-cli-build.js"),
  }).toMatchInlineSnapshot(`
    {
      "ember-cli-build.js": "module.exports = function (defaults) {
      let app = new EmberApp(defaults, {
        sassOptions: { implementation: require('sass'), includePaths: ['app/styles'] },
      });
    };
    ",
      "ember-cli-sass": "^x",
      "node-sass": undefined,
      "sass": "^x",
    }
  `);
  expect(emberCliSass.detect(app)).toBe(false);
});
