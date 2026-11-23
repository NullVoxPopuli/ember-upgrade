import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { readClassicComponent } from "#codemods/classic-component/read.js";

/**
 * @param {ReturnType<typeof readClassicComponent>} component
 */
function summary(component) {
  if (!component) return component;

  return {
    form: component.form,
    className: component.className,
    superClass: component.superClass,
    mixins: component.mixins,
    outerHtml: component.outerHtml,
    positionalParams: component.positionalParams,
    members: component.members.map((member) =>
      [
        member.name,
        member.kind,
        member.keys.join(","),
        member.observes ? `observes:${member.observes.join(",")}` : "",
        member.decorators.join(","),
      ]
        .filter(Boolean)
        .join(" "),
    ),
    unreadable: component.unreadable,
  };
}

/**
 * From emberobserver/client app/components/svg-icon.js.
 */
test("Component.extend with reopenClass", () => {
  let source = `import Component from '@ember/component';

export default Component.extend({
  tagName: '',
  alignBaseline: true,
}).reopenClass({
  positionalParams: ['iconName'],
});
`;

  expect(summary(readClassicComponent(source, "svg-icon.js"))).toMatchInlineSnapshot(`
    {
      "className": undefined,
      "form": "extend",
      "members": [
        "alignBaseline field",
      ],
      "mixins": [],
      "outerHtml": {
        "attributeBindings": [],
        "classNameBindings": [],
        "classNames": [],
        "tagName": "",
      },
      "positionalParams": [
        "iconName",
      ],
      "superClass": "Component",
      "unreadable": [],
    }
  `);
});

/**
 * emberx-select 3.1.1 (MIT), addon/components/x-select.js.
 */
test("Component.extend with on, observer, computed, and string keys", () => {
  let source = readFileSync(join(import.meta.dirname, "fixtures/x-select.js.txt"), "utf8");

  expect(summary(readClassicComponent(source, "x-select.js"))).toMatchInlineSnapshot(`
    {
      "className": undefined,
      "form": "extend",
      "members": [
        "disabled field",
        "multiple field",
        "options computed",
        "tabindex field",
        "on-blur method",
        "on-click method",
        "on-change method",
        "on-focus-out method",
        "_handleAction method",
        "change method",
        "click method",
        "blur method",
        "focusOut method",
        "_getValue method",
        "_findMultipleValues method",
        "_findSingleValue method",
        "_setDefaultValues method",
        "__setDefaultValues method",
        "didInsertElement method",
        "willDestroyElement method",
        "ensureProperType on init observes:value",
        "actions actions",
      ],
      "mixins": [],
      "outerHtml": {
        "attributeBindings": [
          "disabled",
          "tabindex",
          "multiple",
          "form",
          "name",
          "autofocus",
          "required",
          "size",
          "title",
        ],
        "classNameBindings": [
          ":x-select",
        ],
        "classNames": [],
        "tagName": "select",
      },
      "positionalParams": [],
      "superClass": "Component",
      "unreadable": [],
    }
  `);
});

/**
 * In the style of CenterForOpenScience/ember-osf-web.
 */
test("a native class with @ember-decorators", () => {
  let source = `import Component from '@ember/component';
import { action, computed } from '@ember/object';
import { tagName, classNames } from '@ember-decorators/component';

@tagName('span')
@classNames('node-card')
export default class NodeCard extends Component {
  static positionalParams = ['node'];

  showTags = false;
  node;

  @computed('node.title')
  get title() {
    return this.node.title;
  }

  didInsertElement() {
    super.didInsertElement();
  }

  @action
  toggleTags() {
    this.toggleProperty('showTags');
  }
}
`;

  expect(summary(readClassicComponent(source, "node-card.js"))).toMatchInlineSnapshot(`
    {
      "className": "NodeCard",
      "form": "class",
      "members": [
        "showTags field",
        "node field",
        "title getter computed('node.title')",
        "didInsertElement method",
        "toggleTags method action",
      ],
      "mixins": [],
      "outerHtml": {
        "attributeBindings": [],
        "classNameBindings": [],
        "classNames": [
          "node-card",
        ],
        "tagName": "span",
      },
      "positionalParams": [
        "node",
      ],
      "superClass": "Component",
      "unreadable": [],
    }
  `);
});

test("a Glimmer component is not classic", () => {
  let source = `import Component from '@glimmer/component';
export default class Greeting extends Component {}
`;

  expect(readClassicComponent(source, "greeting.js")).toBeUndefined();
});
