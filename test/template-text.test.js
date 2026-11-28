import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preprocess } from "@glimmer/syntax";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import templateText, { escapeStrayLessThan } from "#stages/template-text/index.js";

/**
 * From documize/community at e19bcd0, gui/app/templates/components/customize/user-list.hbs, shortened.
 */
const USER_LIST = `<div class="perms">
	<div class="perm-name">{{localize 'permission_analytics'}}</div>
	<div class="perm-desc">{{localize 'permission_analytics_explain'}}<</div>
	{{!-- a < b --}}
	<p title="{{if this.low "a < b"}}">Price < 5, <:named>x</:named> <@arg /></p>
</div>
`;

test("a stray < becomes &lt;, and tags and mustaches stay", () => {
  expect(escapeStrayLessThan(USER_LIST)).toMatchInlineSnapshot(`
    "<div class="perms">
    	<div class="perm-name">{{localize 'permission_analytics'}}</div>
    	<div class="perm-desc">{{localize 'permission_analytics_explain'}}&lt;</div>
    	{{!-- a < b --}}
    	<p title="{{if this.low "a < b"}}">Price &lt; 5, <:named>x</:named> <@arg /></p>
    </div>
    "
  `);
});

test("Ember's template parser reads &lt; as the text <", () => {
  let template = preprocess(escapeStrayLessThan("<p>a<</p>"));
  let paragraph = /** @type {any} */ (template.body[0]);

  expect(paragraph.children.map((/** @type {any} */ node) => node.chars)).toEqual(["a<"]);
});

test("the stage changes only the templates with a stray <", async () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries({
    "package.json": "{}",
    "app/templates/a.hbs": "<p>a<</p>\n",
    "app/templates/b.hbs": "<p>{{b}}</p>\n",
  })) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  let app = new Project(directory);

  expect(templateText.detect(app)).toBe(true);

  await templateText.run(app);

  expect(app.read("app/templates/a.hbs")).toBe("<p>a&lt;</p>\n");
  expect(app.read("app/templates/b.hbs")).toBe("<p>{{b}}</p>\n");
  expect(templateText.detect(app)).toBe(false);
});
