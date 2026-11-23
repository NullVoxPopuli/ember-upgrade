import { expect, test } from "vitest";

import { needsActionHandler, rewriteTemplate } from "#codemods/classic-component/template.js";
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

test("the action modifier becomes on, and keeps what it did to the event", () => {
  let component = readClassicComponent(
    `import Component from '@ember/component';
export default Component.extend({
  tagName: '',
  toggle() {},
  pick(value) {},
  actions: {
    save(item) {},
  },
});
`,
    "panel.js",
  );

  if (!component) throw new Error("not a classic component");

  let names = {
    args: new Set(["item"]),
    defaults: new Map(),
    callbacks: new Map(),
    tracked: new Set(),
    declared: new Set(),
    conflicts: new Set(),
    getters: false,
  };
  let glimmer = { source: "", unreadable: [], modifier: undefined, helpers: [], elementId: false };
  let template = `<button {{action "save" this.item}}>Save</button>
<button type="button" {{action "toggle"}}>Toggle</button>
<div {{action "toggle"}}>{{yield}}</div>
<li {{action "pick" on="doubleClick" bubbles=false}}>Pick</li>
<span {{action "pick" this.item}}>Pick</span>
<a href="/" {{action "toggle" preventDefault=false}}>Home</a>
<form {{action "save" this.item on="submit"}}></form>
<span {{action (mut this.open) true}}>Open</span>
`;

  expect(rewriteTemplate(template, component, names, glimmer)).toMatchInlineSnapshot(`
    {
      "template": "<button {{on "click" (this.handleAction (fn this.save @item))}}>Save</button>
    <button type="button" {{on "click" this.toggle}}>Toggle</button>
    <div {{on "click" (this.handleAction this.toggle)}}>{{yield}}</div>
    <li {{on "dblclick" (this.handleAction this.pick preventDefault=false bubbles=false)}}>Pick</li>
    <span {{on "click" (fn this.pick @item)}}>Pick</span>
    <a href="/" {{on "click" this.toggle}}>Home</a>
    <form {{on "submit" (this.handleAction (fn this.save @item))}}></form>
    <span {{on "click" (fn (mut this.open) true)}}>Open</span>
    ",
      "unreadable": [],
    }
  `);
  expect(needsActionHandler(template, component)).toBe(true);
  expect(needsActionHandler(`<span {{action "toggle"}}></span>`, component)).toBe(false);
});

test("the action modifier with allowedKeys stays", () => {
  let component = readClassicComponent(
    `import Component from '@ember/component';
export default Component.extend({ toggle() {} });
`,
    "panel.js",
  );

  if (!component) throw new Error("not a classic component");

  let names = {
    args: new Set(),
    defaults: new Map(),
    callbacks: new Map(),
    tracked: new Set(),
    declared: new Set(),
    conflicts: new Set(),
    getters: false,
  };
  let glimmer = { source: "", unreadable: [], modifier: undefined, helpers: [], elementId: false };

  expect(
    rewriteTemplate(
      `<span {{action "toggle" allowedKeys="shift"}}></span>`,
      component,
      names,
      glimmer,
    ).unreadable,
  ).toEqual([`the action modifier with allowedKeys=: {{action "toggle" allowedKeys="shift"}}`]);
});
