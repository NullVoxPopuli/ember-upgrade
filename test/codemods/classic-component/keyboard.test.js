import { expect, test } from "vitest";

import { rewriteKeyboard } from "#codemods/classic-component/keyboard.js";

/**
 * From code-corps-ember (MIT), shortened.
 */
test("the ember-keyboard mixin goes away, and keyDown names the listener", () => {
  let source = `import Component from '@ember/component';
import { on } from '@ember/object/evented';
import { EKMixin as EmberKeyboardMixin, keyDown, keyUp } from 'ember-keyboard';

export default Component.extend(EmberKeyboardMixin, {
  classNames: ['task-card'],

  closeOnEsc: on(keyDown('Escape'), function() {
    this.close();
  }),

  release: on(keyUp('alt+KeyA'), function() {}),
});
`;

  expect(rewriteKeyboard(source, "a.js")).toMatchInlineSnapshot(`
    "import Component from '@ember/component';
    import { on } from '@ember/object/evented';

    export default Component.extend({
      keyboardActivated: false,
      classNames: ['task-card'],

      closeOnEsc: on('keydown:Escape', function() {
        this.close();
      }),

      release: on('keyup:alt+KeyA', function() {}),
    });
    "
  `);
});

test("a mixin that activates on init starts active, unless the class sets keyboardActivated", () => {
  let source = `import Component from '@ember/component';
import { EKOnInitMixin } from 'ember-keyboard';

export const A = Component.extend(EKOnInitMixin, {
  tagName: '',
});

export const B = Component.extend(EKOnInitMixin, {
  keyboardActivated: false,
});
`;

  expect(rewriteKeyboard(source, "a.js")).toMatchInlineSnapshot(`
    "import Component from '@ember/component';

    export const A = Component.extend({
      keyboardActivated: true,
      tagName: '',
    });

    export const B = Component.extend({
      keyboardActivated: false,
    });
    "
  `);
});

test("the focus mixin stays", () => {
  let source = `import Component from '@ember/component';
import { EKOnFocusMixin } from 'ember-keyboard';

export default Component.extend(EKOnFocusMixin, {});
`;

  expect(rewriteKeyboard(source, "a.js")).toBe(source);
});
