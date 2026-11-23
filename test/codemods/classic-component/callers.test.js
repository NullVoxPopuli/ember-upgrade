import { expect, test } from "vitest";

import { rewriteCallers } from "#codemods/classic-component/callers.js";

const COMPONENTS = new Map([
  ["svg-icon", { positionalParams: ["iconName"], hasElement: false, callbacks: new Map() }],
  [
    "x-select",
    {
      positionalParams: [],
      hasElement: true,
      callbacks: new Map([["value", "onValueChange"]]),
    },
  ],
]);

/**
 * From emberobserver/client, shortened.
 */
test("curly invocations become angle brackets, with positional arguments by name", () => {
  let template = `<button>{{svg-icon "close" alignBaseline=false}}</button>
{{#x-select value=this.position class="wide" as |xs|}}
  {{#xs.option value=1}}{{svg-icon "one"}}{{/xs.option}}
{{/x-select}}
<XSelect @value={{this.parent}} />
{{yield (hash icon=(component "svg-icon" "github"))}}
{{#x-select value="fixed"}}a{{else}}b{{/x-select}}
{{svg-icon "too" "many"}}
`;

  expect(rewriteCallers(template, COMPONENTS)).toMatchInlineSnapshot(`
    {
      "template": "<button><SvgIcon @iconName="close" @alignBaseline={{false}} /></button>
    <XSelect @value={{this.position}} class="wide" @onValueChange={{fn (mut this.position)}} as |xs|>
      {{#xs.option value=1}}<SvgIcon @iconName="one" />{{/xs.option}}
    </XSelect>
    <XSelect @onValueChange={{fn (mut this.parent)}} @value={{this.parent}} />
    {{yield (hash icon=(component "svg-icon" iconName="github"))}}
    {{#x-select value="fixed"}}a{{else}}b{{/x-select}}
    {{svg-icon "too" "many"}}
    ",
      "unreadable": [
        "svg-icon gets more positional arguments than it names: {{svg-icon "too" "many"}}",
      ],
    }
  `);
});

/**
 * From emberobserver/client, shortened.
 */
test("@class and @id of an angle bracket invocation become attributes", () => {
  expect(
    rewriteCallers(
      `<XSelect @class="test-addon-dependencies" @id="deps" @value={{this.x}} />\n`,
      COMPONENTS,
    ).template,
  ).toMatchInlineSnapshot(`
    "<XSelect @onValueChange={{fn (mut this.x)}} class="test-addon-dependencies" id="deps" @value={{this.x}} />
    "
  `);
});
