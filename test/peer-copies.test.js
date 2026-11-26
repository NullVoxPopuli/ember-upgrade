import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import composableHelpers from "#stages/addons/composable-helpers.js";
import peerCopies, { peerMismatches } from "#stages/peer-copies/index.js";

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

const HDS = "node_modules/@hashicorp/design-system-components";

/**
 * From hashicorp-forge/hermes: @hashicorp/design-system-components 3.6.0 brings ember-style-modifier,
 * a v1 addon, with its own @ember/string 3, and ember-composable-helpers 5.0.0.
 */
function hermes() {
  return project({
    "package.json": {
      name: "hermes",
      dependencies: { "@hashicorp/design-system-components": "^3.1.0" },
      devDependencies: { "@ember/string": "^4.0.1" },
    },
    "node_modules/@ember/string/package.json": { name: "@ember/string", version: "4.0.1" },
    [`${HDS}/package.json`]: {
      name: "@hashicorp/design-system-components",
      version: "3.6.0",
      keywords: ["ember-addon"],
      "ember-addon": { version: 2 },
      dependencies: {
        "ember-composable-helpers": "^5.0.0",
        "ember-style-modifier": "^3.0.1",
      },
    },
    [`${HDS}/node_modules/ember-style-modifier/package.json`]: {
      name: "ember-style-modifier",
      version: "3.1.1",
      keywords: ["ember-addon"],
      peerDependencies: { "@ember/string": "^3.0.1" },
    },
    [`${HDS}/node_modules/@ember/string/package.json`]: {
      name: "@ember/string",
      version: "3.1.1",
    },
    [`${HDS}/node_modules/ember-composable-helpers/package.json`]: {
      name: "ember-composable-helpers",
      version: "5.0.0",
      keywords: ["ember-addon"],
    },
  });
}

test("a v1 addon deep in the tree with another copy of a peer gets the app's copy", async () => {
  let app = hermes();

  expect(peerMismatches(app)).toMatchInlineSnapshot(`
    [
      {
        "addons": [
          "ember-style-modifier",
        ],
        "name": "@ember/string",
        "range": "^4.0.1",
      },
    ]
  `);

  await peerCopies.run(app);

  expect(app.packageJson.overrides).toMatchInlineSnapshot(`
    {
      "@ember/string": "^4.0.1",
    }
  `);
  expect(peerCopies.detect(app)).toBe(false);
});

test("an addon that depends on ember-composable-helpers needs the fork, with no direct dependency", () => {
  let app = hermes();

  expect(app.dependency("ember-composable-helpers")).toBeUndefined();
  expect(composableHelpers.detect(app)).toBe(true);

  app.write(
    "package.json",
    JSON.stringify(
      Object.assign(app.packageJson, {
        overrides: {
          "ember-composable-helpers": "npm:@nullvoxpopuli/ember-composable-helpers@^5.3.2",
        },
      }),
    ),
  );

  expect(composableHelpers.detect(app)).toBe(false);
});
