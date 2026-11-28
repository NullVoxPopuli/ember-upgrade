import { expect, test } from "vitest";

import { nativeAppClass } from "#stages/app-class/index.js";

/**
 * From documize/community gui/app/app.js, shortened.
 */
test("Application.extend becomes the class of the app blueprint", () => {
  let source = `import Application from '@ember/application';
import Resolver from './resolver';
import loadInitializers from 'ember-load-initializers';
import config from './config/environment';

let App;

App = Application.extend({
    modulePrefix: config.modulePrefix,
    podModulePrefix: config.podModulePrefix,
    Resolver
});

loadInitializers(App, config.modulePrefix);

export default App;
`;

  expect(nativeAppClass(source, "app/app.js")).toMatchInlineSnapshot(`
    "import Application from '@ember/application';
    import Resolver from './resolver';
    import loadInitializers from 'ember-load-initializers';
    import config from './config/environment';


    class App extends Application {
      modulePrefix = config.modulePrefix;
      podModulePrefix = config.podModulePrefix;
      Resolver = Resolver;
    }

    loadInitializers(App, config.modulePrefix);

    export default App;
    "
  `);
});

test("the export default and const forms move too, and an object with a method stays", () => {
  expect(
    nativeAppClass(
      `import Application from '@ember/application';
export default Application.extend({ modulePrefix: 'x' });
`,
      "app/app.js",
    ),
  ).toMatchInlineSnapshot(`
    "import Application from '@ember/application';
    export default class App extends Application {
      modulePrefix = 'x';
    }
    "
  `);

  let withMethod = `import Application from '@ember/application';
const App = Application.extend({ init() { this._super(...arguments); } });
export default App;
`;

  expect(nativeAppClass(withMethod, "app/app.js")).toBe(withMethod);
});
