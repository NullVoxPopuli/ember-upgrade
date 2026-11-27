import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import stage, { publicFunnel } from "#stages/public-funnel/index.js";

/**
 * From ember-learn/ember-api-docs lib/api-docs-data/index.js (MIT).
 */
const ADDON = `'use strict';

const Funnel = require('broccoli-funnel');

module.exports = {
  name: require('./package').name,

  isDevelopingAddon() {
    return true;
  },

  treeForPublic() {
    return new Funnel('ember-api-docs-data', {
      include: ['**/json-docs/**', '**/rev-index/**'],
    });
  },
};
`;

test("an in-repo addon that only copies a folder into the public tree", () => {
  expect(publicFunnel(ADDON, "lib/api-docs-data/index.js")).toEqual({
    folder: "ember-api-docs-data",
    include: ["**/json-docs/**", "**/rev-index/**"],
    exclude: [],
    destDir: "",
  });
  expect(
    publicFunnel(ADDON.replace("isDevelopingAddon()", "included()"), "lib/x/index.js"),
  ).toBeUndefined();
});

test("the Vite plugin copies the files that the Funnel included", async () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));
  let files = {
    "package.json": JSON.stringify({ "ember-addon": { paths: ["lib/api-docs-data"] } }),
    "vite.config.mjs":
      "import { defineConfig } from 'vite';\n\nexport default defineConfig({\n  plugins: [],\n});\n",
    "lib/api-docs-data/index.js": ADDON,
    "lib/api-docs-data/package.json": JSON.stringify({ name: "api-docs-data" }),
    "ember-api-docs-data/json-docs/ember/6.0.0/classes/Component.json": "{}",
    "ember-api-docs-data/rev-index/ember-6.0.0.json": "{}",
    "ember-api-docs-data/README.md": "not public",
  };

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  let app = new Project(directory);

  expect(stage.detect(app)).toBe(true);
  expect(await stage.run(app)).toEqual([]);
  expect(app.has("lib/api-docs-data")).toBe(false);
  expect(app.read("vite.config.mjs")).toContain("apiDocsData");

  let plugin = (await import(pathToFileURL(join(directory, "vite/api-docs-data.mjs")).href))
    .default;
  let dist = join(directory, "dist");

  plugin.writeBundle({ dir: dist });

  expect(existsSync(join(dist, "json-docs/ember/6.0.0/classes/Component.json"))).toBe(true);
  expect(existsSync(join(dist, "rev-index/ember-6.0.0.json"))).toBe(true);
  expect(existsSync(join(dist, "README.md"))).toBe(false);
});
