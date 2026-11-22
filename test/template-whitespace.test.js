import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import templateWhitespace from "#stages/template-whitespace/index.js";

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
 * From rust-lang/crates.io: app/templates/support.gjs and tests/acceptance/support-test.js, shortened.
 */
test("expected text loses the indentation that content-tag removes from the template", async () => {
  let app = project({
    "app/templates/support.gjs": `<template>
  <ul>
    <li>
      <a href='mailto:help@crates.io'>
        For all other cases:
        <strong>help@crates.io</strong>
      </a>
    </li>
  </ul>
</template>
`,
    "tests/acceptance/support-test.js": `test('shows an inquire list', async function (assert) {
  assert.deepEqual(
    listitem.map(item => item.textContent.trim()),
    [
      \`For all other cases:
        help@crates.io\`,
    ],
  );
  assert.strictEqual(\`a
        not in a template\`, x);
});
`,
  });

  expect(templateWhitespace.detect(app)).toBe(true);

  await templateWhitespace.run(app);

  expect(app.read("tests/acceptance/support-test.js")).toMatchInlineSnapshot(`
    "test('shows an inquire list', async function (assert) {
      assert.deepEqual(
        listitem.map(item => item.textContent.trim()),
        [
          \`For all other cases:
          help@crates.io\`,
        ],
      );
      assert.strictEqual(\`a
            not in a template\`, x);
    });
    "
  `);
  expect(templateWhitespace.detect(app)).toBe(false);
});
