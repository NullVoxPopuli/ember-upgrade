import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import patchedPackages, { dropPatches } from "#stages/patched-packages/index.js";

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
 * From ember-learn/ember-website (MIT): pnpm-workspace.yaml patches ember-page-title for any version,
 * and pnpm-lock.yaml has 9.0.3.
 */
function website() {
  return project({
    "package.json": JSON.stringify({
      name: "ember-website",
      devDependencies: { "ember-page-title": "^9.0.3" },
    }),
    "pnpm-lock.yaml": "",
    "pnpm-workspace.yaml":
      "patchedDependencies:\n  ember-page-title: patches/ember-page-title.patch\n",
    "patches/ember-page-title.patch":
      "diff --git a/dist/services/page-title.js b/dist/services/page-title.js\n",
    "node_modules/ember-page-title/package.json": JSON.stringify({
      name: "ember-page-title",
      version: "9.0.3",
    }),
  });
}

test("a package with a patch for any version stays at the version that the app has", async () => {
  let app = website();

  expect(patchedPackages.detect(app)).toBe(true);

  await patchedPackages.run(app);

  expect(app.dependency("ember-page-title")).toBe("9.0.3");
  expect(patchedPackages.detect(app)).toBe(false);
});

test("an update of a patched package removes the patch, which was for the version before", () => {
  let app = website();

  dropPatches(app, ["ember-page-title", "ember-source"]);

  expect(app.read("pnpm-workspace.yaml")).toBe("");
  expect(existsSync(join(app.directory, "patches/ember-page-title.patch"))).toBe(false);
});

test("the stage has work before an install, when the range of a patched package is no exact version", () => {
  let app = website();

  rmSync(join(app.directory, "node_modules"), { recursive: true });

  expect(patchedPackages.detect(app)).toBe(true);
});
