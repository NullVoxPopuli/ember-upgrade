import { expect, test } from "vitest";

import { addYamlListEntry, setYamlMapEntry } from "#manager-settings.js";

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
