import { expect, test } from "vitest";

import { classifyNames } from "#codemods/classic-component/args.js";
import { readClassicComponent } from "#codemods/classic-component/read.js";
import { classUsage } from "#codemods/classic-component/usage.js";

/**
 * @param {string} source
 * @param {{ passed?: string[], templateReads?: string[], templateWrites?: string[], open?: boolean }} options
 */
function classify(source, options) {
  let component = readClassicComponent(source, "component.js");

  if (!component) throw new Error("not a classic component");

  let fromClass = classUsage(component.node);
  let templateReads = new Set(options.templateReads ?? []);
  let reads = new Set(Array.from(fromClass.reads).concat(Array.from(templateReads)));
  let writes = new Set(Array.from(fromClass.writes).concat(options.templateWrites ?? []));
  let names = classifyNames(component, {
    passed: new Set(options.passed ?? []),
    reads,
    writes,
    templateReads,
    members: new Map(component.members.map((member) => [member.name, classUsage(member.node)])),
    open: options.open,
    leaks: fromClass.leaks,
  });

  return {
    args: Array.from(names.args),
    defaults: Object.fromEntries(names.defaults),
    callbacks: Object.fromEntries(names.callbacks),
    tracked: Array.from(names.tracked),
    declared: Array.from(names.declared),
    conflicts: Array.from(names.conflicts),
    getters: names.getters,
  };
}

test("arguments, defaults, callbacks, and tracked state", () => {
  let source = `import Component from '@ember/component';
export default Component.extend({
  isOpen: false,
  value: null,
  label: 'Name',
  count: 0,
  _seen: false,

  toggle() {
    this.isOpen = !this.isOpen;
    this.value = this.count;
  },

  didReceiveAttrs() {
    if (!this._seen) this._seen = true;
    this.onReady(this.title);
  },
});
`;

  expect(
    classify(source, {
      passed: ["value", "label"],
      templateReads: ["isOpen", "label", "draft"],
      templateWrites: ["draft"],
    }),
  ).toMatchInlineSnapshot(`
    {
      "args": [
        "value",
        "label",
        "onReady",
        "title",
      ],
      "callbacks": {
        "value": "onValueChange",
      },
      "conflicts": [],
      "declared": [
        "draft",
      ],
      "defaults": {
        "label": "'Name'",
      },
      "getters": false,
      "tracked": [
        "isOpen",
        "draft",
      ],
    }
  `);
});

test("a component that callers get from the component helper takes every field as an argument", () => {
  let source = `import Component from '@ember/component';
export default Component.extend({
  value: null,
  disabled: false,
  didInsertElement() {
    this.register(this);
  },
});
`;

  expect(classify(source, { passed: ["register"], open: true })).toMatchInlineSnapshot(`
    {
      "args": [
        "value",
        "disabled",
        "register",
      ],
      "callbacks": {},
      "conflicts": [],
      "declared": [],
      "defaults": {
        "disabled": "false",
      },
      "getters": true,
      "tracked": [],
    }
  `);
});
