import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  addOverride,
  addYamlListEntry,
  releaseAge,
  setYamlMapEntry,
  setYamlNestedMap,
} from "#manager-settings.js";
import { Project } from "#project.js";

/**
 * From TryGhost/Ghost at 6c43413, shortened.
 */
const GHOST = `packages:
  - 'ghost/*'
  - 'apps/*'

strictDepBuilds: true
catalogMode: strict

allowBuilds:
  # sentry-cli's postinstall downloads its binary.
  '@sentry/cli': false
  '@swc/core': true
  esbuild: true

catalog:
  ember-source: 3.24.0
`;

test("adds an entry to an existing block map, and keeps the comments and the blocks after it", () => {
  expect(setYamlMapEntry(GHOST, "allowBuilds", "ember-styleguide", true)).toBe(`packages:
  - 'ghost/*'
  - 'apps/*'

strictDepBuilds: true
catalogMode: strict

allowBuilds:
  # sentry-cli's postinstall downloads its binary.
  '@sentry/cli': false
  '@swc/core': true
  esbuild: true
  ember-styleguide: true

catalog:
  ember-source: 3.24.0
`);
});

test("changes an entry with a quoted name in place", () => {
  let result = setYamlMapEntry(GHOST, "allowBuilds", "@sentry/cli", true);

  expect(result).toContain("  '@sentry/cli': true\n  '@swc/core': true");
  expect(result).not.toContain("'@sentry/cli': false");
});

test("adds a new block at the end", () => {
  expect(setYamlMapEntry(GHOST, "overrides", "@ember/test-waiters", "^4.1.2")).toBe(
    GHOST + "\noverrides:\n  '@ember/test-waiters': '^4.1.2'\n",
  );
});

test("makes a file when there is none", () => {
  expect(
    setYamlMapEntry("", "overrides", "babel-plugin-ember-template-compilation", "^4.0.1"),
  ).toBe("overrides:\n  babel-plugin-ember-template-compilation: '^4.0.1'\n");
});

test("turns an empty flow map into a block", () => {
  expect(setYamlMapEntry("overrides: {}\n", "overrides", "esbuild", "^0.25.0")).toBe(
    "overrides:\n  esbuild: '^0.25.0'\n",
  );
});

test("adds a list entry once", () => {
  let once = addYamlListEntry(
    "onlyBuiltDependencies:\n  - esbuild\n",
    "onlyBuiltDependencies",
    "ember-styleguide",
  );

  expect(once).toBe("onlyBuiltDependencies:\n  - esbuild\n  - ember-styleguide\n");
  expect(addYamlListEntry(once, "onlyBuiltDependencies", "ember-styleguide")).toBe(once);
});

test("adds and replaces a packageExtensions entry", () => {
  let added = setYamlNestedMap(
    GHOST,
    "packageExtensions",
    "ember-code-snippet@<3",
    "dependencies",
    {
      "broccoli-plugin": "^1.3.1",
    },
  );

  expect(added).toBe(
    GHOST +
      "\npackageExtensions:\n  'ember-code-snippet@<3':\n    dependencies:\n      broccoli-plugin: '^1.3.1'\n",
  );
  expect(
    setYamlNestedMap(added, "packageExtensions", "ember-code-snippet@<3", "dependencies", {
      "broccoli-plugin": "^1.3.1",
    }),
  ).toBe(added);
});

/**
 * @param {object} pkg
 */
function pnpmProject(pkg) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  writeFileSync(join(directory, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

  return { directory, project: new Project(directory) };
}

test("a pnpm override goes in pnpm-workspace.yaml", () => {
  let { directory, project } = pnpmProject({ packageManager: "pnpm@10.34.9" });

  addOverride(project, "ember-cli-htmlbars", "^7.0.1");

  expect(readFileSync(join(directory, "pnpm-workspace.yaml"), "utf8")).toContain(
    "ember-cli-htmlbars: '^7.0.1'",
  );
});

test("a pnpm override goes in resolutions when package.json has them, because pnpm then ignores the others", () => {
  let { directory, project } = pnpmProject({
    packageManager: "pnpm@10.34.9",
    resolutions: { "ember-auto-import": "2.13.1" },
  });

  addOverride(project, "ember-cli-htmlbars", "^7.0.1");

  expect(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).resolutions).toEqual({
    "ember-auto-import": "2.13.1",
    "ember-cli-htmlbars": "^7.0.1",
  });
  expect(readFileSync(join(directory, "pnpm-workspace.yaml"), "utf8")).not.toContain("overrides");
});

test("the minimum release age comes from the workspace of the app", () => {
  let root = mkdtempSync(join(tmpdir(), "release-age-"));

  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - 'ghost/*'\nminimumReleaseAge: 4320 # 3 days in minutes\n",
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, "package.json"), "{}\n");

  expect(releaseAge(new Project(root))).toBe(4320);
});

test("an .npmrc sets the minimum release age, and no setting is 0", () => {
  let root = mkdtempSync(join(tmpdir(), "release-age-"));

  writeFileSync(join(root, "package.json"), "{}\n");
  expect(releaseAge(new Project(root))).toBe(0);

  writeFileSync(join(root, ".npmrc"), "minimum-release-age=1440\n");
  expect(releaseAge(new Project(root))).toBe(1440);
});
