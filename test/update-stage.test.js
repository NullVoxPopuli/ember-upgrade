import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { updateStage, v2Addons } from "#stages/addons/updates.js";

/**
 * @param {Record<string, string>} files
 */
function project(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  return new Project(directory);
}

/**
 * From emberobserver/client, after the vite stage, shortened.
 */
test("an update moves older pins of what the release needs to its ranges, and declares its peers", async () => {
  let app = project({
    "yarn.lock": "",
    "package.json": JSON.stringify({
      devDependencies: { "ember-concurrency": "^5.3.0", "ember-power-select": "^4.1.3" },
      resolutions: {
        "ember-basic-dropdown": "3.0.16",
        "ember-element-helper": "^1.0.0",
      },
    }),
  });

  let stage = updateStage("ember-power-select", {
    version: "9.0.6",
    addon: true,
    v2: true,
    repository: undefined,
    dependencies: { "ember-element-helper": "^0.8.8", "ember-modifier": "^4.3.0" },
    peerDependencies: {
      "ember-basic-dropdown": "^9.0.1",
      "ember-concurrency": "^5.3.0",
      "ember-source": ">= 4.12.0",
    },
  });

  expect(stage.detect(app)).toBe(true);

  await stage.run(app);

  let { devDependencies, resolutions } = JSON.parse(app.read("package.json"));

  expect({ devDependencies, resolutions }).toMatchInlineSnapshot(`
    {
      "devDependencies": {
        "ember-basic-dropdown": "^9.0.1",
        "ember-concurrency": "^5.3.0",
        "ember-power-select": "^9.0.6",
      },
      "resolutions": {
        "ember-basic-dropdown": "^9.0.1",
        "ember-element-helper": "^1.0.0",
      },
    }
  `);
  expect(app.read("ember-upgrade-progress.yaml")).toContain(
    "ember-basic-dropdown (3.0.16, and ember-power-select 9.0.6 asks for ^9.0.1)",
  );
  expect(stage.detect(app)).toBe(false);
});

/**
 * From skylines-project/skylines: ember-bootstrap 4 is a v1 addon with ember-auto-import 1,
 * which cannot load ember-concurrency 4, a v2 addon.
 */
test("an older pin goes away when its new range would force a v2 addon on a v1 addon that cannot load one", async () => {
  let app = project({
    "yarn.lock": "",
    "package.json": JSON.stringify({
      devDependencies: { "ember-bootstrap": "^4.9.0", "ember-concurrency": "^2.3.7" },
      resolutions: { "ember-concurrency": "2.3.7" },
    }),
    "node_modules/ember-bootstrap/package.json": JSON.stringify({
      name: "ember-bootstrap",
      version: "4.9.0",
      keywords: ["ember-addon"],
      dependencies: { "ember-auto-import": "^1.12.2", "ember-concurrency": "^2.1.2" },
    }),
  });

  let stage = updateStage("ember-concurrency", {
    version: "4.0.6",
    addon: true,
    v2: true,
    repository: undefined,
    dependencies: {},
    peerDependencies: {},
  });

  await stage.run(app);

  expect(JSON.parse(app.read("package.json")).resolutions).toEqual({});
});

/**
 * From hashicorp-forge/hermes: ember-animated-tools 1 brings its own ember-animated 1,
 * next to the app's ember-animated 2. ember-animated-tools 2 accepts ember-animated 2.
 */
test("a v2 addon with an old copy of another addon of the app updates when its latest release accepts the app's copy", async () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: {
        "ember-animated": "^2.2.0",
        "ember-animated-tools": "^1.0.0",
        "ember-source": "~6.12.0",
      },
    }),
    "node_modules/ember-animated/package.json": JSON.stringify({
      name: "ember-animated",
      version: "2.2.0",
      keywords: ["ember-addon"],
      "ember-addon": { version: 2 },
    }),
    "node_modules/ember-animated-tools/package.json": JSON.stringify({
      name: "ember-animated-tools",
      version: "1.0.0",
      keywords: ["ember-addon"],
      "ember-addon": { version: 2 },
      dependencies: { "ember-animated": "^1.0.0" },
    }),
    "node_modules/ember-animated-tools/node_modules/ember-animated/package.json": JSON.stringify({
      name: "ember-animated",
      version: "1.1.4",
      keywords: ["ember-addon"],
      "ember-addon": { version: 2 },
    }),
    "package-lock.json": "{}",
  });

  let stages = await v2Addons.expand(app);

  expect(stages.map((stage) => stage.name)).toEqual(["update-ember-animated-tools"]);
});

/**
 * From hashicorp-forge/hermes: ember-power-select 8 has its own copy of ember-basic-dropdown, and
 * ember-power-select-with-create 3.1.0, its latest release, accepts only ember-power-select 8.
 */
test("an update stays at the major that the peer ranges of the installed addons accept", async () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: {
        "ember-basic-dropdown": "^8.8.0",
        "ember-power-select": "^8.12.0",
        "ember-power-select-with-create": "^3.1.0",
        "ember-source": "~6.12.0",
        "ember-truth-helpers": "^5.0.0",
      },
    }),
    "node_modules/ember-basic-dropdown/package.json": JSON.stringify({
      name: "ember-basic-dropdown",
      version: "8.8.0",
      keywords: ["ember-addon"],
      "ember-addon": { version: 2 },
    }),
    "node_modules/ember-power-select/package.json": JSON.stringify({
      name: "ember-power-select",
      version: "8.12.0",
      keywords: ["ember-addon"],
      "ember-addon": { version: 2 },
      dependencies: { "ember-basic-dropdown": "^8.0.4" },
    }),
    "node_modules/ember-power-select/node_modules/ember-basic-dropdown/package.json":
      JSON.stringify({
        name: "ember-basic-dropdown",
        version: "8.0.4",
        keywords: ["ember-addon"],
        "ember-addon": { version: 2 },
      }),
    "node_modules/ember-power-select-with-create/package.json": JSON.stringify({
      name: "ember-power-select-with-create",
      version: "3.1.0",
      keywords: ["ember-addon"],
      "ember-addon": { version: 2 },
      peerDependencies: { "ember-power-select": "^8.12.0" },
    }),
    "package-lock.json": "{}",
  });

  let stages = await v2Addons.expand(app);

  expect(stages.map((stage) => stage.name)).toEqual([]);
});
