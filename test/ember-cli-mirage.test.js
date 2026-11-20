import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  plan,
  printIndex,
  printMirageModel,
  readModel,
  removeDiscovery,
  rewriteImports,
  serverShape,
} from "#stages/addons/ember-cli-mirage.js";
import { Project } from "#project.js";

/**
 * The snippets come from CenterForOpenScience/ember-osf-web.
 */
const CONTRIBUTOR = `import { attr, belongsTo, AsyncBelongsTo, AsyncHasMany } from '@ember-data/model';
import { buildValidations, validator } from 'ember-cp-validations';

import OsfModel, { Permission } from './osf-model';
import UserModel from './user';

export default class ContributorModel extends OsfModel.extend(Validations) {
    @attr('fixstring') permission!: Permission;
    @attr('boolean') bibliographic!: boolean;

    @belongsTo('user', { inverse: 'contributors' })
    users!: AsyncBelongsTo<UserModel> & UserModel;

    @belongsTo('node', { inverse: 'contributors', polymorphic: true })
    node!: AsyncBelongsTo<NodeModel> & NodeModel;

    isUnregistered = false;
}
`;

test("the relationships of an ember-data model become a mirage model", () => {
  let model = readModel(CONTRIBUTOR, "app/models/contributor.ts");

  expect(model?.parents).toEqual(["./osf-model"]);
  expect(model?.problems).toEqual([]);
  expect(printMirageModel(model?.relationships ?? [], "    "))
    .toBe(`import { Model, belongsTo } from 'miragejs';

export default Model.extend({
    users: belongsTo('user', { inverse: 'contributors' }),
    node: belongsTo('node', { inverse: 'contributors', polymorphic: true }),
});
`);
});

test("a classic model with no model name keeps mirage's default", () => {
  let model = readModel(
    `import DS from 'ember-data';

export default DS.Model.extend({
  name: DS.attr('string'),
  comments: DS.hasMany({ inverse: null }),
});
`,
    "app/models/post.js",
  );

  expect(printMirageModel(model?.relationships ?? [], "  "))
    .toBe(`import { Model, hasMany } from 'miragejs';

export default Model.extend({
  comments: hasMany({ inverse: null }),
});
`);
});

test("a file that does not import ember-data is not a model", () => {
  expect(readModel(`export default function () {}\n`, "app/models/helpers.js")).toBeUndefined();
});

test("value imports move to miragejs, and type imports stay on the app's declarations", () => {
  let source = `import { association, Factory, ID, trait, Trait } from 'ember-cli-mirage';
import faker from 'faker';

export interface UserTraits {
    loggedIn: Trait;
}

export default Factory.extend<{ id: ID } & UserTraits>({
    defaultRegion: association(),
    loggedIn: trait({}),
});
`;

  expect(
    rewriteImports(source, "mirage/factories/user.ts", { prefix: "ember-osf-web", ownTypes: true })
      .source,
  ).toBe(`import { association, Factory, trait } from 'miragejs';
import type { ID, Trait } from 'ember-cli-mirage';
import faker from 'faker';

export interface UserTraits {
    loggedIn: Trait;
}

export default Factory.extend<{ id: ID } & UserTraits>({
    defaultRegion: association(),
    loggedIn: trait({}),
});
`);
});

test("a type-only import becomes `import type`", () => {
  let source = `import { HandlerContext, Schema } from 'ember-cli-mirage';
import faker from 'faker';

export function createToken(this: HandlerContext, schema: Schema) {
    return schema.tokens.create({ tokenId: faker.random.uuid() });
}
`;

  expect(
    rewriteImports(source, "mirage/views/token.ts", { prefix: "ember-osf-web", ownTypes: true })
      .source,
  ).toBe(source.replace("import {", "import type {"));
});

test("in JS, every miragejs export moves, and a missing one stays for the user", () => {
  let result = rewriteImports(
    `import { Factory, discoverEmberDataModels, faker } from 'ember-cli-mirage';\n`,
    "mirage/factories/post.js",
    { prefix: "app", ownTypes: false },
  );

  expect(result.leftovers).toEqual([`faker from "ember-cli-mirage"`]);
  expect(result.source).toBe(
    `import { Factory, discoverEmberDataModels, faker } from 'ember-cli-mirage';\n`,
  );

  expect(
    rewriteImports(
      `import { Factory, discoverEmberDataModels } from 'ember-cli-mirage';\nexport default Factory.extend({});\n`,
      "mirage/factories/post.js",
      { prefix: "app", ownTypes: false },
    ).source,
  ).toBe(`import { Factory } from 'miragejs';\nexport default Factory.extend({});\n`);
});

test("tests import setupMirage and startMirage from the app's helper", () => {
  let result = rewriteImports(
    `import { run } from '@ember/runloop';
import { startMirage } from 'ember-osf-web/initializers/ember-cli-mirage';
import { setupMirage } from 'ember-cli-mirage/test-support';
import { setupTest } from 'ember-qunit';
`,
    "tests/unit/models/osf-model-test.ts",
    { prefix: "ember-osf-web", ownTypes: true },
  );

  expect(result.startMirage).toBe(true);
  expect(result.source).toBe(`import { run } from '@ember/runloop';
import { startMirage } from 'ember-osf-web/tests/helpers/mirage';
import { setupMirage } from 'ember-osf-web/tests/helpers/mirage';
import { setupTest } from 'ember-qunit';
`);
});

test("the routes function and the makeServer function are both server configs", () => {
  expect(
    serverShape(
      `import { Server } from 'ember-cli-mirage';\n\nexport default function(this: Server) {\n    this.passthrough();\n}\n`,
      "mirage/config.ts",
    ),
  ).toEqual({ kind: "routes", testConfig: false });

  expect(
    serverShape(
      `export default function (config) {\n  return createServer({ ...config, routes });\n}\nexport function testConfig() {}\n`,
      "mirage/config.js",
    ),
  ).toEqual({ kind: "make-server", testConfig: true });

  expect(serverShape(`export default { routes() {} };\n`, "mirage/config.js")).toBeUndefined();
});

test("the makeServer config stops calling the discovery helpers", () => {
  let result = removeDiscovery(
    `import { discoverEmberDataModels, applyEmberDataSerializers } from 'ember-cli-mirage';
import { createServer } from 'miragejs';

export default function (config) {
  let finalConfig = {
    ...config,
    models: { ...discoverEmberDataModels(), ...config.models },
    serializers: applyEmberDataSerializers(config.serializers),
    routes,
  };

  return createServer(finalConfig);
}
`,
    "mirage/config.js",
  );

  expect(result.serializers).toBe(true);
  expect(result.source).toContain("models: { ...config.models },");
  expect(result.source).toContain("serializers: config.serializers,");
});

test("fixtures are named in the plural, as ember-cli-mirage named them", () => {
  expect(printIndex("fixtures", ["external-citation-service", "licenses"], "    ")).toBe(
    `import externalCitationService from './fixtures/external-citation-service';
import licenses from './fixtures/licenses';

export default {
    externalCitationServices: externalCitationService,
    licenses,
};
`,
  );

  expect(printIndex("scenarios", ["default"], "  ")).toContain(
    "import defaultScenario from './scenarios/default';",
  );
});

/** @type {string[]} */
let folders = [];

afterEach(() => {
  for (let folder of folders) rmSync(folder, { recursive: true, force: true });
  folders = [];
});

/**
 * @param {Record<string, string>} files
 */
function project(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-cli-mirage-"));

  folders.push(directory);

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  return new Project(directory);
}

test("the plan writes the models, the server, the initializer, and the test helper", () => {
  let result = plan(
    project({
      "package.json": JSON.stringify({
        name: "ember-osf-web",
        devDependencies: { "ember-cli-mirage": "^2.4.0" },
      }),
      "config/environment.js": `module.exports = function () {\n  return { modulePrefix: 'ember-osf-web', 'ember-cli-mirage': { enabled: false } };\n};\n`,
      "app/models/osf-model.ts": `import Model from '@ember-data/model';\n\nexport default class OsfModel extends Model {}\n`,
      "app/models/contributor.ts": CONTRIBUTOR,
      "mirage/config.ts": `import { Server } from 'ember-cli-mirage';\n\nexport default function(this: Server) {\n    this.passthrough();\n}\n`,
      "mirage/models/root.js": `import { Model, belongsTo } from 'ember-cli-mirage';\n\nexport default Model.extend({\n    currentUser: belongsTo('user'),\n});\n`,
      "mirage/factories/utils.ts": `export function guid() {}\n`,
      "mirage/scenarios/default.ts": `export default function() {}\n`,
      "tests/acceptance/tokens-test.ts": `import { setupMirage } from 'ember-cli-mirage/test-support';\n`,
    }),
  );

  expect(result.blockers).toEqual([]);
  expect(result.move).toBe(true);
  expect(Array.from(result.writes.keys()).sort()).toEqual([
    "app/initializers/mirage.ts",
    "app/mirage/config.ts",
    "app/mirage/models.ts",
    "app/mirage/models/contributor.ts",
    "app/mirage/models/osf-model.ts",
    "app/mirage/models/root.js",
    "app/mirage/servers/default.ts",
    "tests/acceptance/tokens-test.ts",
    "tests/helpers/mirage.ts",
  ]);
  expect(result.writes.get("app/mirage/models.ts"))
    .toBe(`import contributor from './models/contributor';
import osfModel from './models/osf-model';
import root from './models/root';

export default {
    contributor,
    osfModel,
    root,
};
`);
  expect(result.writes.get("app/mirage/servers/default.ts"))
    .toBe(`import { createServer } from 'miragejs';

import routes from '../config';
import models from '../models';
import defaultScenario from '../scenarios/default';

/**
 * ember-cli-mirage found these modules at runtime. ember-mirage needs them imported.
 */
export default function makeServer(environment: string) {
    return createServer({
        environment,
        models,
        scenarios: { default: defaultScenario },
        routes,
    });
}
`);
});

test("an app/mirage folder blocks the move", () => {
  let result = plan(
    project({
      "package.json": JSON.stringify({
        name: "x",
        devDependencies: { "ember-cli-mirage": "^2.4.0" },
      }),
      "mirage/config.js": `export default function () {}\n`,
      "app/mirage/x.js": "",
    }),
  );

  expect(result.blockers.map((b) => b.title)).toEqual([
    "app/mirage exists, and mirage/ must move there",
  ]);
});
