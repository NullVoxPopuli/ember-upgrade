import { expect, test } from "vitest";

import { updateImports } from "#codemods/imports.js";

test("removes unused names from the given modules, and adds the needed ones", () => {
  let source = `import classic from 'ember-classic-decorator';
import { action, computed } from '@ember/object';
import { inject as service } from '@ember/service';
import Component from '@glimmer/component';

export default class Panel extends Component {
  @service router;
  @action
  close() {}
}
`;

  expect(
    updateImports(source, "panel.js", {
      prune: ["ember-classic-decorator", "@ember/object"],
      add: new Map([
        ["@glimmer/tracking", new Set(["tracked"])],
        ["@ember/object", new Set(["get", "action"])],
      ]),
    }),
  ).toMatchInlineSnapshot(`
    "import { action, get } from '@ember/object';
    import { inject as service } from '@ember/service';
    import Component from '@glimmer/component';
    import { tracked } from '@glimmer/tracking';

    export default class Panel extends Component {
      @service router;
      @action
      close() {}
    }
    "
  `);
});

/**
 * From code-corps/code-corps-ember app/components/donation/donation-container.js, after the conversion.
 */
test("adds imports after the last import that stays", () => {
  let source = `import Component from '@glimmer/component';
import { or, empty } from '@ember/object/computed';

export default class DonationContainer extends Component {}
`;

  expect(
    updateImports(source, "donation-container.js", {
      prune: ["@ember/object/computed"],
      add: new Map([["@ember/utils", new Set(["isEmpty"])]]),
    }),
  ).toMatchInlineSnapshot(`
    "import Component from '@glimmer/component';
    import { isEmpty } from '@ember/utils';

    export default class DonationContainer extends Component {}
    "
  `);
});
