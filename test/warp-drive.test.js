import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { readProgress } from "#progress.js";
import warpDrive, {
  LEGACY_STORE,
  withInstall,
  withWarpDriveInflection,
  withStrictTypes,
  withStringUtils,
  withTrackingResolved,
} from "#stages/warp-drive/index.js";

/**
 * The files are from emberobserver/client after the ember-nvp stage, shortened.
 */
test("app.js installs Ember's reactivity for WarpDrive", () => {
  expect(
    withInstall(`import Application from "@ember/application";
import config from "#config";
import loadInitializers from "ember-load-initializers";

export default class App extends Application {}
`),
  ).toMatchInlineSnapshot(`
    "import Application from "@ember/application";
    import config from "#config";
    import loadInitializers from "ember-load-initializers";
    import "@warp-drive/ember/install";

    export default class App extends Application {}
    "
  `);
});

test("the WarpDrive config marks the tracking package deprecation as resolved", () => {
  expect(
    withTrackingResolved(
      `import { buildMacros } from "@embroider/macros/babel";
import { setConfig } from "@warp-drive/core/build-config";

const macros = buildMacros({
  configure(config) {
    setConfig(config, {
      ___legacy_support: true,
    });
  },
});
`,
      "babel.config.js",
    ),
  ).toMatchInlineSnapshot(`
    "import { buildMacros } from "@embroider/macros/babel";
    import { setConfig } from "@warp-drive/core/build-config";

    const macros = buildMacros({
      configure(config) {
        setConfig(config, {
          ___legacy_support: true,
          deprecations: { DEPRECATE_TRACKING_PACKAGE: false },
        });
      },
    });
    "
  `);
});

test("inflector rules move to WarpDrive's string utilities", () => {
  expect(
    withStringUtils(
      `import Inflector from 'ember-inflector';

export function initialize(/* application */) {
  Inflector.inflector.uncountable('github-stats');
  Inflector.inflector.irregular('person', 'people');
}
`,
      "app/initializers/inflections.js",
    ),
  ).toMatchInlineSnapshot(`
    "import { irregular, uncountable } from "@warp-drive/utilities/string";

    export function initialize(/* application */) {
      uncountable('github-stats');
      irregular('person', 'people');
    }
    "
  `);
});

test("relationship types are normalized", () => {
  expect(
    withStrictTypes(
      `import Model, { attr, hasMany } from '@ember-data/model';

export default class TestResult extends Model {
  @attr('boolean') succeeded;
  @hasMany('emberVersionCompatibility', { async: true, inverse: null }) emberVersionCompatibilities;
  @hasMany('version', { async: true, inverse: null }) versions;
}
`,
      "app/models/test-result.js",
    ),
  ).toMatchInlineSnapshot(`
    "import Model, { attr, hasMany } from '@ember-data/model';

    export default class TestResult extends Model {
      @attr('boolean') succeeded;
      @hasMany('ember-version-compatibility', { async: true, inverse: null }) emberVersionCompatibilities;
      @hasMany('version', { async: true, inverse: null }) versions;
    }
    "
  `);
});

test("a Mirage server inflects with WarpDrive, which has the app's rules", () => {
  expect(
    withWarpDriveInflection(
      `import { createServer } from 'miragejs';
import { pluralize, singularize } from 'ember-inflector';

export default function makeServer(environment) {
  return createServer({ environment, inflector: { pluralize, singularize } });
}
`,
      "mirage/servers/default.js",
    ),
  ).toMatchInlineSnapshot(`
    "import { createServer } from 'miragejs';
    import { pluralize, singularize } from '@warp-drive/utilities/string';

    export default function makeServer(environment) {
      return createServer({ environment, inflector: { pluralize, singularize } });
    }
    "
  `);
  expect(
    withWarpDriveInflection(
      `import { pluralize } from 'ember-inflector';\n\nexport const label = pluralize(2, 'addon');\n`,
      "app/utils/label.js",
    ),
  ).toBeUndefined();
});

/**
 * @param {Record<string, string | object>} files
 */
function project(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(
      join(directory, file),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }

  return new Project(directory);
}

test("the store sets up the legacy request methods on purpose, and record.save() is left to the app", async () => {
  let app = project({
    "package.json": {
      name: "app",
      devDependencies: { "ember-data": "~5.8.2", "@warp-drive/core": "~5.8.2" },
    },
    "app/app.js": `import Application from "@ember/application";\n`,
    "app/services/store.js": `export { default } from "ember-data/store";\n`,
    "app/services/session.js": `export default class { login() { LocalStore.save("token", 1); } }\n`,
    "app/components/review.js": `export default class { async submit() { await this.review.save(); } }\n`,
  });

  expect(warpDrive.detect(app)).toBe(true);

  await warpDrive.run(app);

  expect(app.read("app/services/store.js")).toBe(LEGACY_STORE);
  expect(app.packageJson.devDependencies).toMatchInlineSnapshot(`
    {
      "@warp-drive/core": "~5.8.2",
      "@warp-drive/ember": "~5.8.2",
      "@warp-drive/json-api": "~5.8.2",
      "@warp-drive/legacy": "~5.8.2",
      "ember-data": "~5.8.2",
    }
  `);
  expect(readProgress(app).map((entry) => entry.note)).toMatchInlineSnapshot(`
    [
      "record.save() logs warp-drive:deprecate-legacy-request-methods. These files call save(): app/components/review.js. For each record, call \`store.request(saveRecord(record))\`, with \`saveRecord\` from @warp-drive/legacy/compat/builders.",
    ]
  `);
  expect(warpDrive.detect(app)).toBe(false);
});
