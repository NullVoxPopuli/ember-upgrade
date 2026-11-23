import { expect, test } from "vitest";

import { inlineMixins } from "#codemods/classic-component/mixins.js";

const MIXIN = `import Mixin from '@ember/object/mixin';
import { computed, get } from '@ember/object';
import { alias } from '@ember/object/computed';

const TOTAL_STEPS = 10;
const HALF = TOTAL_STEPS / 2;

export default Mixin.create({
  githubRepo: null,

  state: alias('githubRepo.syncState'),

  /**
   * How far the sync is.
   */
  percentage: computed('stepNumber', function() {
    return (get(this, 'stepNumber') / HALF) * 50;
  }),

  didInsertElement() {
    this.ready = true;
  },
});
`;

/**
 * @param {string} specifier
 */
function resolve(specifier) {
  if (specifier === "my-app/mixins/progress") {
    return { file: "app/mixins/progress.js", source: MIXIN };
  }
}

/**
 * From code-corps-ember (MIT), shortened.
 */
test("the app's mixin moves into the component, and the component's own properties win", () => {
  let source = `import Component from '@ember/component';
import ProgressMixin from 'my-app/mixins/progress';
import { get } from '@ember/object';

export default Component.extend(ProgressMixin, {
  classNames: ['repo-sync'],

  githubRepo: undefined,

  didInsertElement() {
    this.started = true;
  },
});
`;

  expect(inlineMixins(source, "app/components/repo-sync.js", resolve)).toMatchInlineSnapshot(`
    {
      "source": "import Component from '@ember/component';
    import { get, computed } from '@ember/object';
    import { alias } from '@ember/object/computed';

    const TOTAL_STEPS = 10;
    const HALF = TOTAL_STEPS / 2;

    export default Component.extend({
      state: alias('githubRepo.syncState'),

      /**
       * How far the sync is.
       */
      percentage: computed('stepNumber', function() {
        return (get(this, 'stepNumber') / HALF) * 50;
      }),

      classNames: ['repo-sync'],

      githubRepo: undefined,

      didInsertElement() {
        this.started = true;
      },
    });
    ",
      "unreadable": [],
    }
  `);
});

test("a mixin that only the component has", () => {
  let source = `import Component from '@ember/component';
import ProgressMixin from 'my-app/mixins/progress';

export default Component.extend(ProgressMixin);
`;

  expect(inlineMixins(source, "app/components/repo-sync.js", resolve).source)
    .toMatchInlineSnapshot(`
      "import Component from '@ember/component';
      import { get, computed } from '@ember/object';
      import { alias } from '@ember/object/computed';

      const TOTAL_STEPS = 10;
      const HALF = TOTAL_STEPS / 2;

      export default Component.extend({
        githubRepo: null,

        state: alias('githubRepo.syncState'),

        /**
         * How far the sync is.
         */
        percentage: computed('stepNumber', function() {
          return (get(this, 'stepNumber') / HALF) * 50;
        }),

        didInsertElement() {
          this.ready = true;
        },
      });
      "
    `);
});

test("mixins of addons, and a _super call into the mixin, stay", () => {
  let source = `import Component from '@ember/component';
import ProgressMixin from 'my-app/mixins/progress';
import { EKMixin } from 'ember-keyboard';

export default Component.extend(ProgressMixin, EKMixin, {
  didInsertElement() {
    this._super(...arguments);
  },
});
`;

  expect(inlineMixins(source, "app/components/repo-sync.js", resolve)).toMatchInlineSnapshot(`
    {
      "source": "import Component from '@ember/component';
    import ProgressMixin from 'my-app/mixins/progress';
    import { EKMixin } from 'ember-keyboard';

    export default Component.extend(ProgressMixin, EKMixin, {
      didInsertElement() {
        this._super(...arguments);
      },
    });
    ",
      "unreadable": [
        "the mixin EKMixin is not a module of the app",
      ],
    }
  `);
});

test("the component's _super call runs the mixin's method under its own name", () => {
  let source = `import Component from '@ember/component';
import ProgressMixin from 'my-app/mixins/progress';

export default Component.extend(ProgressMixin, {
  didInsertElement() {
    this._super(...arguments);
    this.started = true;
  },
});
`;

  expect(inlineMixins(source, "app/components/repo-sync.js", resolve).source)
    .toMatchInlineSnapshot(`
    "import Component from '@ember/component';
    import { get, computed } from '@ember/object';
    import { alias } from '@ember/object/computed';

    const TOTAL_STEPS = 10;
    const HALF = TOTAL_STEPS / 2;

    export default Component.extend({
      githubRepo: null,

      state: alias('githubRepo.syncState'),

      /**
       * How far the sync is.
       */
      percentage: computed('stepNumber', function() {
        return (get(this, 'stepNumber') / HALF) * 50;
      }),

      progressMixinDidInsertElement() {
        this.ready = true;
      },

      didInsertElement() {
        this.progressMixinDidInsertElement(...arguments);
        this.started = true;
      },
    });
    "
  `);
});
