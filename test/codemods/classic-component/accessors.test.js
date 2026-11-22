import { expect, test } from "vitest";

import { rewriteAccessors } from "#codemods/classic-component/accessors.js";

/**
 * @param {string} source
 */
function rewrite(source) {
  let result = rewriteAccessors(source, "component.js");

  if (!result) throw new Error("does not parse");

  return {
    source: result.source,
    imports: Array.from(result.imports),
    sets: Array.from(result.sets),
    actions: Array.from(result.actions),
  };
}

test("get, set, and the property helpers on this", () => {
  expect(
    rewrite(`export default {
  run(fieldName, other) {
    this.set('reviewProperties', {});
    this.set(\`reviewProperties.\${fieldName}\`, this.get('value'));
    let version = this.get('addon.latestAddonVersion');
    let count = this.set('count', this.get('count') + 1);
    this.toggleProperty('showTable');
    this.incrementProperty('page');
    this.decrementProperty('page', 2);
    this.setProperties({ a: 1, b: this.get('b') });
    let { a, b } = this.getProperties('a', 'b');
    other.get('value');
  },
};
`),
  ).toMatchInlineSnapshot(`
    {
      "actions": [],
      "imports": [
        "set",
        "get",
      ],
      "sets": [
        "reviewProperties",
        "count",
        "showTable",
        "page",
        "a",
        "b",
      ],
      "source": "export default {
      run(fieldName, other) {
        this.reviewProperties = {};
        set(this, \`reviewProperties.\${fieldName}\`, this.value);
        let version = get(this, 'addon.latestAddonVersion');
        let count = (this.count = this.count + 1);
        this.showTable = !this.showTable;
        this.page = (this.page || 0) + 1;
        this.page = (this.page || 0) - 2;
        Object.assign(this, { a: 1, b: this.b });
        let { a, b } = { a: this.a, b: this.b };
        get(other, 'value');
      },
    };
    ",
    }
  `);
});

/**
 * emberx-select 3.1.1 (MIT).
 */
test("sendAction calls the action argument", () => {
  expect(
    rewrite(`export default {
  change(event) {
    this.sendAction('action', this.get('value'), event, this);
    this.sendAction();
    this.get(action)(value, event);
  },
};
`),
  ).toMatchInlineSnapshot(`
    {
      "actions": [
        "action",
      ],
      "imports": [
        "get",
      ],
      "sets": [],
      "source": "export default {
      change(event) {
        this.action?.(this.value, event, this);
        this.action?.();
        get(this, action)(value, event);
      },
    };
    ",
    }
  `);
});
