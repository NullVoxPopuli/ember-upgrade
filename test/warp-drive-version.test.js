import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import warpDriveVersion from "#stages/warp-drive/version.js";

/**
 * @param {object} pkg
 */
function project(pkg) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  writeFileSync(join(directory, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

  return new Project(directory);
}

test("WarpDrive 5.8 moves to 5.9.1, with the range prefix of each package", async () => {
  /**
   * From rust-lang/crates.io, shortened, after the ember-nvp and warp-drive stages.
   */
  let app = project({
    name: "crates-io",
    devDependencies: {
      "@ember-data/rfc395-data": "^0.0.4",
      "@warp-drive/ember": "~5.8.0",
      "@warp-drive/utilities": "5.8.1",
      "ember-data": "5.8.1",
      "ember-source": "~7.4.0",
    },
  });

  expect(warpDriveVersion.detect(app)).toBe(true);

  await warpDriveVersion.run(app);

  expect(app.read("package.json")).toMatchInlineSnapshot(`
    "{
      "name": "crates-io",
      "devDependencies": {
        "@ember-data/rfc395-data": "^0.0.4",
        "@warp-drive/ember": "~5.9.1",
        "@warp-drive/utilities": "5.9.1",
        "ember-data": "5.9.1",
        "ember-source": "~7.4.0"
      }
    }
    "
  `);
  expect(warpDriveVersion.detect(app)).toBe(false);
});

test("ember-data 4 and a range that cannot be read stay", () => {
  let app = project({
    name: "app",
    dependencies: { "ember-data": "~4.12.0", "@warp-drive/core": "catalog:" },
  });

  expect(warpDriveVersion.detect(app)).toBe(false);
});
