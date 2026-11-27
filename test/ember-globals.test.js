import { describe, expect, test } from "vitest";
import { transform } from "#stages/ember-globals/transform.js";

/**
 * @param {string} source
 * @param {string} [file]
 */
function code(source, file = "app/x.js") {
  return transform(source, file).code;
}

describe("ember-globals", () => {
  test("member chains, longest mapping first", () => {
    expect(
      code(`import Ember from 'ember';

export default Ember.Component.extend({
  name: Ember.computed.alias('model.name'),
  total: Ember.computed('a', function () {
    return Ember.get(this, 'a');
  }),
});
`),
    ).toBe(`import Component from '@ember/component';
import { alias } from '@ember/object/computed';
import { computed, get } from '@ember/object';

export default Component.extend({
  name: alias('model.name'),
  total: computed('a', function () {
    return get(this, 'a');
  }),
});
`);
  });

  test("destructures keep the local names", () => {
    expect(
      code(`import Ember from "ember";
const { computed, inject: { service }, run: { later: runLater } } = Ember;

export default Ember.Service.extend({
  store: service(),
  x: computed(() => runLater(() => {}, 1)),
});
`),
    ).toBe(`import { computed } from "@ember/object";
import Service, { inject as service } from "@ember/service";
import { later as runLater } from "@ember/runloop";

export default Service.extend({
  store: service(),
  x: computed(() => runLater(() => {}, 1)),
});
`);
  });

  test("a destructured namespace resolves through its uses", () => {
    expect(
      code(`import Ember from 'ember';
const { get, inject } = Ember;

export default Ember.Route.extend({
  session: inject.service(),
  model() {
    return Ember.get(this, 'x') ?? get(this, 'y');
  },
});
`),
    ).toBe(`import { get } from '@ember/object';
import Route from '@ember/routing/route';
import { inject as service } from '@ember/service';

export default Route.extend({
  session: service(),
  model() {
    return get(this, 'x') ?? get(this, 'y');
  },
});
`);
  });

  test("a destructure keeps only the properties without a module", () => {
    let result = transform(
      `import Ember from 'ember';
const { computed, K, inject } = Ember;
export default { a: computed(() => K), b: inject };
`,
      "app/x.js",
    );

    expect(result.code).toBe(`import Ember from 'ember';
import { computed } from '@ember/object';
const { K, inject } = Ember;
export default { a: computed(() => K), b: inject };
`);
    expect(result.todo.map((item) => item.title)).toEqual([
      "`Ember.inject` as a value has no module",
      "`Ember.K` has no module",
    ]);
  });

  test("a use without a module keeps the ember import", () => {
    let result = transform(
      `import Ember from 'ember';

if (Ember.RouterDSL) Ember.run.later(() => {}, 1);
`,
      "app/x.js",
    );

    expect(result.code).toBe(`import Ember from 'ember';
import { later } from '@ember/runloop';

if (Ember.RouterDSL) later(() => {}, 1);
`);
    expect(result.todo).toMatchObject([
      { title: "`Ember.RouterDSL` has no module", where: ["app/x.js:3"] },
    ]);
  });

  test("a taken name gets a prefix", () => {
    expect(
      code(`import Ember from 'ember';
const computed = 1;
export default Ember.computed(() => computed);
`),
    ).toBe(`import { computed as EmberComputed } from '@ember/object';
const computed = 1;
export default EmberComputed(() => computed);
`);
  });

  test("existing imports are reused", () => {
    expect(
      code(`import Ember from 'ember';
import { computed as c } from '@ember/object';
export default Ember.Object.extend({ x: Ember.computed(() => 1), y: c(() => 2) });
`),
    ).toBe(`import EmberObject from '@ember/object';
import { computed as c } from '@ember/object';
export default EmberObject.extend({ x: c(() => 1), y: c(() => 2) });
`);
  });

  test("gjs keeps its template", () => {
    expect(
      code(
        `import Ember from 'ember';
import Component from '@glimmer/component';

export default class Demo extends Component {
  get later() {
    return Ember.run.later;
  }

  <template>{{this.later}}</template>
}
`,
        "app/components/demo.gjs",
      ),
    ).toBe(`import { later } from '@ember/runloop';
import Component from '@glimmer/component';

export default class Demo extends Component {
  get later() {
    return later;
  }

  <template>{{this.later}}</template>
}
`);
  });

  test("files without an ember import do not change", () => {
    let source = `import Component from '@ember/component';\nexport default Component.extend();\n`;

    expect(code(source)).toBe(source);
  });
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("Ember.onerror becomes a listener of the window's error event", () => {
  let result = transform(
    `import { on } from 'rsvp';
import Ember from 'ember';

if (config.environment === 'production') {
  Ember.onerror = function (error) {
    console.error(error);
  };
}
`,
    "app/app.js",
  );

  expect(result.code).toMatchInlineSnapshot(`
    "import { on } from 'rsvp';

    if (config.environment === 'production') {
      window.addEventListener("error", function ({ error }) {
        console.error(error);
      });
    }
    "
  `);
});

/**
 * From hashicorp-forge/hermes web/app/components/inputs/people-select.ts (MPL-2.0), shortened.
 */
test("Ember.testing becomes isTesting() of @ember/debug, and an assignment setTesting()", () => {
  expect(
    transform(
      `import Ember from "ember";

const DEBOUNCE_MS = Ember.testing ? 0 : 300;
Ember.testing = true;
`,
      "app/components/inputs/people-select.ts",
    ).code,
  ).toMatchInlineSnapshot(`
    "import { isTesting, setTesting } from "@ember/debug";

    const DEBOUNCE_MS = isTesting() ? 0 : 300;
    setTesting(true);
    "
  `);
});
