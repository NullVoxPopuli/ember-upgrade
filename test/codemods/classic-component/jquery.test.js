import { expect, test } from "vitest";

import { rewriteJQuery } from "#codemods/classic-component/jquery.js";

/**
 * emberx-select 3.1.1 (MIT), shortened.
 */
test("the element's jQuery calls become DOM calls", () => {
  let source = `const isSelectedOption = (option) => option.$().is(':selected');

export default {
  didInsertElement() {
    this.$().on('blur', (event) => {
      this.blur(event);
    });

    let value = this.$().val();
    this.$().val(value);
    this.$('.label').addClass('active');
    this.$().find('input').focus;
  },

  willDestroyElement() {
    this.$().off('blur');
  },

  click() {
    this.$().off('blur');
    this.$().fadeIn();
  },
};
`;

  expect(rewriteJQuery(source, "x-select.js", new Set(["willDestroyElement"])))
    .toMatchInlineSnapshot(`
      {
        "source": "const isSelectedOption = (option) => option.element.matches(':checked');

      export default {
        didInsertElement() {
          this.element.addEventListener('blur', (event) => {
            this.blur(event);
          });

          let value = this.element.value;
          this.element.value = value;
          this.element.querySelectorAll('.label').forEach((element) => element.classList.add('active'));
          this.element.querySelector('input').focus;
        },

        willDestroyElement() {
        },

        click() {
          this.$().off('blur');
          this.$().fadeIn();
        },
      };
      ",
        "unreadable": [
          "jQuery: this.$().off('blur')",
          "jQuery: this.$().fadeIn()",
        ],
      }
    `);
});
