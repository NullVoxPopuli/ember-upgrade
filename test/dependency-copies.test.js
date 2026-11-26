import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { acceptsMajor, copyMismatches } from "#stages/dependency-copies/index.js";

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
 * From ember-learn/ember-website after the ember-nvp stage: the lockfile kept Babel 7 for ember-vite.
 */
test("a package that keeps an older major of an app dependency, which its range does not need", () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: {
        "@babel/core": "^8.1.3",
        "@nullvoxpopuli/ember-vite": "2.1.0",
        "old-plugin": "^1.0.0",
      },
    }),
    "node_modules/@babel/core/package.json": JSON.stringify({
      name: "@babel/core",
      version: "8.1.3",
    }),
    "node_modules/@nullvoxpopuli/ember-vite/package.json": JSON.stringify({
      name: "@nullvoxpopuli/ember-vite",
      version: "2.1.0",
      dependencies: { "@babel/core": "^7.28.10 || ^8.0.0" },
    }),
    "node_modules/@nullvoxpopuli/ember-vite/node_modules/@babel/core/package.json": JSON.stringify({
      name: "@babel/core",
      version: "7.29.13",
    }),
    "node_modules/old-plugin/package.json": JSON.stringify({
      name: "old-plugin",
      version: "1.0.0",
      dependencies: { "@babel/core": "^7.0.0" },
    }),
    "node_modules/old-plugin/node_modules/@babel/core/package.json": JSON.stringify({
      name: "@babel/core",
      version: "7.29.13",
    }),
  });

  expect(copyMismatches(app)).toEqual([
    { name: "@babel/core", range: "^8.1.3", users: ["@nullvoxpopuli/ember-vite"] },
  ]);
});

test("the ranges that accept a major", () => {
  expect(
    [
      "^7.28.10 || ^8.0.0",
      "^7.0.0",
      ">= 7",
      ">=7 <8",
      "*",
      "~8.1.0",
      "8.1.3",
      "^7.4.0 || ^8.0.0-0 <8.0.0",
      ">=7 <8.1",
    ].map((range) => [range, acceptsMajor(range, 8)]),
  ).toEqual([
    ["^7.28.10 || ^8.0.0", true],
    ["^7.0.0", false],
    [">= 7", true],
    [">=7 <8", false],
    ["*", true],
    ["~8.1.0", true],
    ["8.1.3", true],
    ["^7.4.0 || ^8.0.0-0 <8.0.0", false],
    [">=7 <8.1", true],
  ]);
});
