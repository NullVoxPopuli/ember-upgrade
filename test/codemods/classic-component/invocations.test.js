import { expect, test } from "vitest";

import { angleName, findInvocations } from "#codemods/classic-component/invocations.js";

test("angle bracket names", () => {
  expect([angleName("svg-icon"), angleName("admin/review-form"), angleName("x-select")])
    .toMatchInlineSnapshot(`
      [
        "SvgIcon",
        "Admin::ReviewForm",
        "XSelect",
      ]
    `);
});

/**
 * From emberobserver/client, shortened.
 */
test("each form of invocation, with its arguments", () => {
  let template = `{{svg-icon "close" alignBaseline=false}}
{{#svg-icon "stars" class=(concat "dependency " this.class)}}text{{/svg-icon}}
<SvgIcon @iconName="google" @title="Search" class="x" />
{{component "svg-icon" "github" title="GitHub"}}
{{svg-icon-other "nope"}}
<Other @svgIcon={{true}} />
`;

  expect(
    findInvocations(template, "svg-icon").map(({ kind, named, positional }) => ({
      kind,
      named,
      positional,
    })),
  ).toMatchInlineSnapshot(`
    [
      {
        "kind": "curly",
        "named": [
          "alignBaseline",
        ],
        "positional": 1,
      },
      {
        "kind": "block",
        "named": [
          "class",
        ],
        "positional": 1,
      },
      {
        "kind": "angle",
        "named": [
          "iconName",
          "title",
        ],
        "positional": 0,
      },
      {
        "kind": "component",
        "named": [
          "title",
        ],
        "positional": 1,
      },
    ]
  `);
});
