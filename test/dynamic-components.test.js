import { expect, test } from "vitest";

import { angleBracketComponents } from "#stages/dynamic-components/index.js";

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
