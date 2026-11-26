import { expect, test } from "vitest";

import { angleBracketComponents, concatComponents } from "#stages/dynamic-components/index.js";

/**
 * From emberobserver/client app/components/admin-addon-review-form.hbs, shortened,
 * with a block form and a string name added.
 */
test("components that are values use angle brackets", () => {
  let template = `<ExclusiveButtonGroup @selectedValue={{this.value}} as |btn|>
  {{component btn
              value=1
              label="Yes"}}
  {{#component this.wrapper title=(t "review") as |inner|}}
    {{inner.body}}
  {{/component}}
  {{component "static-name" value=2}}
</ExclusiveButtonGroup>
`;

  expect(angleBracketComponents(template)).toMatchInlineSnapshot(`
    "<ExclusiveButtonGroup @selectedValue={{this.value}} as |btn|>
      <btn @value={{1}} @label="Yes" />
      <this.wrapper @title={{t "review"}} as |inner|>
        {{inner.body}}
      </this.wrapper>
      {{component "static-name" value=2}}
    </ExclusiveButtonGroup>
    "
  `);
});

/**
 * From documize/community gui/app/components/section/base-renderer.hbs, with a block form added.
 */
test("a name that concat builds becomes a choice between the components that it can name", () => {
  let template = `<div class="wysiwyg">
	{{component (concat "section/" @page.contentType "/type-renderer") page=@page}}
	{{#component (concat "section/" this.kind "/editor") title="x" as |editor|}}
		{{editor.body}}
	{{/component}}
	{{component (concat "widgets/" this.name)}}
</div>
`;
  let components = new Set([
    "section/code/type-renderer",
    "section/table/type-renderer",
    "section/code/editor",
    "section/deep/table/type-renderer",
    "ui/ui-button",
  ]);

  expect(concatComponents(template, components)).toMatchInlineSnapshot(`
    {
      "output": "<div class="wysiwyg">
    	{{#let (get (hash code=(component "section/code/type-renderer") table=(component "section/table/type-renderer")) @page.contentType) as |SelectedComponent|}}<SelectedComponent @page={{@page}} />{{/let}}
    	{{#let (get (hash code=(component "section/code/editor")) this.kind) as |SelectedComponent|}}<SelectedComponent @title="x" as |editor|>
    		{{editor.body}}
    	</SelectedComponent>{{/let}}
    </div>
    ",
      "removed": [
        "widgets/*",
      ],
    }
  `);
});
