import { expect, test } from "vitest";

import { rewritePrototypeExtensions } from "#codemods/classic-component/prototype-extensions.js";

/**
 * From code-corps-ember (MIT), shortened.
 */
test("the function prototype extensions become on, observer, and computed", () => {
  let source = `import Component from '@ember/component';
import { computed } from '@ember/object';

export default Component.extend({
  _setup: (function() {
    this.scrollBottom();
  }).on('didInsertElement'),

  validate: function() {
    this.check();
  }.observes('email'),

  label: function() {
    return this.name;
  }.property('name'),
});
`;

  expect(rewritePrototypeExtensions(source, "a.js")).toMatchInlineSnapshot(`
    "import Component from '@ember/component';
    import { computed, observer } from '@ember/object';
    import { on } from '@ember/object/evented';

    export default Component.extend({
      _setup: on('didInsertElement', function() {
        this.scrollBottom();
      }),

      validate: observer('email', function() {
        this.check();
      }),

      label: computed('name', function() {
        return this.name;
      }),
    });
    "
  `);
});
