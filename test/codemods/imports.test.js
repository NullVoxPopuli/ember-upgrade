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
