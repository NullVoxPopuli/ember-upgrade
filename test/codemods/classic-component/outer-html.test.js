import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { writeOuterHtml } from "#codemods/classic-component/outer-html.js";
import { readClassicComponent } from "#codemods/classic-component/read.js";

/**
 * @param {string} name
 */
function fixture(name) {
  return readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
}

/**
 * @param {string} source
 * @param {string} template
 */
function wrap(source, template) {
  let component = readClassicComponent(source, "component.js");

  if (!component) throw new Error("not a classic component");

  return writeOuterHtml(template, component);
}

/**
 * From emberobserver/client app/components/svg-icon.js.
 */
test("tagName '' renders no element", () => {
  let source = `import Component from '@ember/component';
export default Component.extend({ tagName: '' });
`;
  let template = `<svg class="icon"><use xlink:href="#icon-{{this.iconName}}"></use></svg>\n`;

  expect(wrap(source, template)).toMatchInlineSnapshot(`
    {
      "events": [],
      "template": "<svg class="icon"><use xlink:href="#icon-{{this.iconName}}"></use></svg>
    ",
    }
  `);
});

/**
 * emberx-select 3.1.1 (MIT).
 */
test("tagName, classNameBindings, attributeBindings, and event methods", () => {
  expect(wrap(fixture("x-select.js.txt"), fixture("x-select.hbs.txt"))).toMatchInlineSnapshot(`
    {
      "events": [
        "change",
        "click",
        "focusOut",
      ],
      "template": "<select class="x-select" disabled={{this.disabled}} tabindex={{this.tabindex}} multiple={{this.multiple}} form={{this.form}} name={{this.name}} autofocus={{this.autofocus}} required={{this.required}} size={{this.size}} title={{this.title}} ...attributes {{on "change" this.change}} {{on "click" this.click}} {{on "focusout" this.focusOut}}>
    {{yield
      (hash
        option=(component "x-option" select=this register=(action 'registerOption') unregister=(action 'unregisterOption'))
      )
    }}
    </select>
    ",
    }
  `);
});

test("the default div, decorators, each classNameBindings form, and a void tag", () => {
  let card = `import Component from '@ember/component';
import { classNames, classNameBindings, attributeBindings } from '@ember-decorators/component';

@classNames('card')
@classNameBindings('isOpen', 'kind', 'isActive:active', 'isPublic:public:private', ':static-class')
@attributeBindings('url:href', 'title')
export default class Card extends Component {
  kind = 'primary';
  elementId = 'card-1';

  click() {}
  doubleClick() {}
}
`;
  let input = `import Component from '@ember/component';
export default Component.extend({ tagName: 'input', attributeBindings: ['value'] });
`;

  expect({
    card: wrap(card, "{{yield}}\n"),
    input: wrap(input, ""),
  }).toMatchInlineSnapshot(`
    {
      "card": {
        "events": [
          "click",
          "doubleClick",
        ],
        "template": "<div id="card-1" class="card {{if this.isOpen "is-open"}} {{this.kind}} {{if this.isActive "active"}} {{if this.isPublic "public" "private"}} static-class" href={{this.url}} title={{this.title}} ...attributes {{on "click" this.click}} {{on "dblclick" this.doubleClick}}>
    {{yield}}
    </div>
    ",
      },
      "input": {
        "events": [],
        "template": "<input value={{this.value}} ...attributes />
    ",
      },
    }
  `);
});
