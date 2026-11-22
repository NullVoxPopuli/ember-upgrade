import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import templateColocation from "#stages/template-colocation/index.js";

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
 * From emberobserver/client, shortened, with a nested component and a layout import added.
 */
test("component templates move next to their classes", async () => {
  let app = project({
    "app/components/addon-size.js": "export default class AddonSize {}",
    "app/templates/components/addon-size.hbs": "{{this.size}}",
    "app/components/date-nav.js": "export default class DateNav {}",
    "app/templates/components/date-nav.hbs": "<nav></nav>",
    "app/components/admin/review/index.js": "export default class Review {}",
    "app/templates/components/admin/review.hbs": "<form></form>",
    "app/templates/components/only-template.hbs": "Hello",
    "app/components/legacy.js":
      "import layout from '../templates/components/legacy';\nexport default class Legacy {}",
    "app/templates/components/legacy.hbs": "Old",
  });

  expect(templateColocation.detect(app)).toBe(true);

  let todo = await templateColocation.run(app);

  expect({
    templates: app.files(["app/**/*.hbs"]),
    todo: todo.map((item) => item.title),
  }).toMatchInlineSnapshot(`
    {
      "templates": [
        "app/components/addon-size.hbs",
        "app/components/admin/review/index.hbs",
        "app/components/date-nav.hbs",
        "app/components/only-template.hbs",
        "app/templates/components/legacy.hbs",
      ],
      "todo": [
        "Move app/templates/components/legacy.hbs next to its component",
      ],
    }
  `);
  expect(templateColocation.detect(app)).toBe(false);
});
