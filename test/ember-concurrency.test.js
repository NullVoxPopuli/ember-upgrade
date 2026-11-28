import { expect, test } from "vitest";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "#project.js";
import stage, { addTaskTransform } from "#stages/ember-concurrency/index.js";

/**
 * From emberobserver/client, after the vite stage.
 */
test("the transform of ember-concurrency is the first babel plugin", () => {
  expect(
    addTaskTransform(
      `export default {
  plugins: [
    ['babel-plugin-ember-template-compilation', {}],
    ...babelCompatSupport(),
  ],
};
`,
      "babel.config.mjs",
    ),
  ).toMatchInlineSnapshot(`
    "export default {
      plugins: [
        "ember-concurrency/async-arrow-task-transform",
        ['babel-plugin-ember-template-compilation', {}],
        ...babelCompatSupport(),
      ],
    };
    "
  `);
});

test("a babel config without plugins is left to the person", () => {
  expect(addTaskTransform("export default {};\n", "babel.config.mjs")).toBeUndefined();
});

/**
 * From ember-learn/ember-api-docs ember-cli-build.js (MIT), shortened.
 */
test("the transform stays out of the Babel config when ember-cli-build adds it", async () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));
  let babel = "export default { plugins: [] };\n";

  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ devDependencies: { "ember-concurrency": "^4.0.0" } }),
  );
  writeFileSync(
    join(directory, "ember-cli-build.js"),
    `module.exports = function (defaults) {
  let app = new EmberApp(defaults, {
    babel: { plugins: [require.resolve('ember-concurrency/async-arrow-task-transform')] },
  });
};
`,
  );
  writeFileSync(join(directory, "babel.config.mjs"), babel);

  let app = new Project(directory);

  expect((await stage.check(app)).blockers).toEqual([]);

  await stage.run(app);

  expect(app.read("babel.config.mjs")).toBe(babel);
});
