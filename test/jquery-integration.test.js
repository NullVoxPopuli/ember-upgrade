import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import jqueryIntegration from "#stages/jquery-integration/index.js";

/**
 * @param {Record<string, string | object>} files
 */
function project(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(
      join(directory, file),
      typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
    );
  }

  return new Project(directory);
}

/**
 * From documize/community gui/app/components, shortened.
 * classic-components keeps subclasses of TextField, so their jQuery calls are still there.
 */
test("the jQuery calls of the classic components that stay use the DOM", async () => {
  let app = project({
    "package.json": { name: "documize", devDependencies: { "@ember/jquery": "^1.1.0" } },
    "config/optional-features.json": { "jquery-integration": true },
    "app/components/focus-input.js": `import TextField from '@ember/component/text-field';

export default TextField.extend({
    didInsertElement() {
        this._super(...arguments);
        this.$().focus();
    }
});
`,
    "app/components/legacy.js": `import Component from '@ember/component';

export default Component.extend({
    didInsertElement() {
        this.$().plugin();
    }
});
`,
  });

  expect((await jqueryIntegration.check(app)).blockers.map((blocker) => blocker.where)).toEqual([
    ["app/components/legacy.js"],
  ]);

  app.write("app/components/legacy.js", "export default 1;\n");
  await jqueryIntegration.run(app);

  expect(app.read("app/components/focus-input.js")).toMatchInlineSnapshot(`
    "import TextField from '@ember/component/text-field';

    export default TextField.extend({
        didInsertElement() {
            this._super(...arguments);
            this.element.focus();
        }
    });
    "
  `);
  expect(app.packageJson.devDependencies).toEqual({});
  expect(app.read("config/optional-features.json")).toContain('"jquery-integration": false');
});
