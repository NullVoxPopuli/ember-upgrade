import { expect, test } from "vitest";

import { rewriteTemplate } from "#codemods/classic-component/template.js";
import { readClassicComponent } from "#codemods/classic-component/read.js";

test("arguments, the action helper, and a caller's callback", () => {
  let component = readClassicComponent(
    `import Component from '@ember/component';
export default Component.extend({ tagName: 'section', classNameBindings: ['isOpen'], isOpen: false });
`,
    "panel.js",
  );

  if (!component) throw new Error("not a classic component");

  let names = {
    args: new Set(["title", "value", "isOpen"]),
    defaults: new Map(),
    callbacks: new Map([["value", "onValueChange"]]),
    tracked: new Set(),
    declared: new Set(),
    conflicts: new Set(),
    getters: false,
  };
  let glimmer = {
    source: "",
    unreadable: [],
    modifier: "lifecycle",
    helpers: [{ name: "didReceiveAttrs", args: ["@title"] }],
    elementId: false,
  };
  let template = `<h1>{{this.title}} {{this.attrs.title}}</h1>
<Child @value={{this.value}} @onValueChange={{fn (mut this.value)}} @save={{action "save" this.title}} @close={{action this.close}} />
`;

  expect(rewriteTemplate(template, component, names, glimmer)).toMatchInlineSnapshot(`
    {
      "template": "<section class="{{if this.isOpen "is-open"}}" ...attributes {{this.lifecycle}}>
    {{this.didReceiveAttrs @title}}
    <h1>{{@title}} {{@title}}</h1>
    <Child @value={{@value}} @onValueChange={{@onValueChange}} @save={{fn this.save @title}} @close={{this.close}} />
    </section>
    ",
      "unreadable": [],
    }
  `);
});
