import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { includedImports } from "#stages/addons/included.js";

/**
 * From torii 1.0.0 index.js (MIT): the hook reads the app's config through `app.project`.
 */
test("an included hook that only reads the app's config imports nothing", () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));
  let files = {
    "package.json": JSON.stringify({ name: "hermes" }),
    "config/environment.js":
      "module.exports = function () { return { torii: { sessionServiceName: 'session' } }; };\n",
    "node_modules/torii/package.json": JSON.stringify({ name: "torii", keywords: ["ember-addon"] }),
    "node_modules/torii/index.js": `'use strict';

module.exports = {
  name: require('./package').name,
  included: function (app) {
    var hostApp = this._findApp(app);
    var toriiConfig = hostApp.project.config(app.env)['torii'];
    if (!toriiConfig && hostApp === app) {
      console.warn('Torii is installed but not configured in config/environment.js!');
    }

    this._super.included(app);
  },

  _findApp: function (hostApp) {
    var app = this.app || hostApp;
    while (app.app) {
      app = app.app;
    }
    return app;
  },
};
`,
  };

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  expect(includedImports(new Project(directory), join(directory, "node_modules/torii"))).toEqual(
    [],
  );
});
