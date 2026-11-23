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

test("the element itself from jQuery", () => {
  let source = `export default {
  scroll() {
    let first = this.$()[0];
    let [thread] = this.$();
    let trigger = this.$('.trigger').get(0);
  },
};
`;

  expect(rewriteJQuery(source, "a.js", new Set()).source).toMatchInlineSnapshot(`
    "export default {
      scroll() {
        let first = this.element;
        let thread = this.element;
        let trigger = this.element.querySelector('.trigger');
      },
    };
    "
  `);
});

/**
 * From code-corps-ember (MIT), shortened.
 */
test("the elements next to the element, its computed style, and triggered events", () => {
  let source = `export default {
  didRender() {
    let parentBottom = this.$().parent()[0].getBoundingClientRect().bottom;
    let next = this.$().next();
    let height = this.$().css('height');
    let color = this.$().css('background-color');
    this.$('.trigger').trigger('blur');
    this.$().trigger('mouseleave');
    this.$().trigger('change');
  },
};
`;

  expect(rewriteJQuery(source, "a.js", new Set())).toMatchInlineSnapshot(`
    {
      "source": "export default {
      didRender() {
        let parentBottom = this.element.parentElement.getBoundingClientRect().bottom;
        let next = this.element.nextElementSibling;
        let height = getComputedStyle(this.element).height;
        let color = getComputedStyle(this.element)['background-color'];
        this.element.querySelector('.trigger').blur();
        this.element.dispatchEvent(new Event('mouseleave'));
        this.element.dispatchEvent(new Event('change', { bubbles: true }));
      },
    };
    ",
      "unreadable": [],
    }
  `);
});

test("a variable that holds an element next to the element, and triggers an event", () => {
  let source = `export default {
  archive() {
    let next = this.$().next();
    if (next) next.trigger('mouseenter');
  },

  other() {
    let previous = this.$().prev();
    previous.addClass('active');
  },
};
`;

  expect(rewriteJQuery(source, "a.js", new Set())).toMatchInlineSnapshot(`
    {
      "source": "export default {
      archive() {
        let next = this.element.nextElementSibling;
        if (next) next.dispatchEvent(new Event('mouseenter'));
      },

      other() {
        let previous = this.$().prev();
        previous.addClass('active');
      },
    };
    ",
      "unreadable": [
        "jQuery: this.$().prev()",
      ],
    }
  `);
});
