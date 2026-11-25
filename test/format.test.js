import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import format, { changedFiles } from "#stages/format/index.js";

/**
 * @param {string} directory
 * @param {Record<string, string>} files
 */
function write(directory, files) {
  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }
}

/**
 * @param {string} directory
 * @param {string} message
 */
function commit(directory, message) {
  execFileSync("git", ["add", "-A"], { cwd: directory });
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message],
    { cwd: directory },
  );
}

test("the files that the stages changed get the app's Prettier style, and the others stay", async () => {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  execFileSync("git", ["init", "-q"], { cwd: directory });
  write(directory, {
    ".gitignore": "node_modules\n",
    "package.json": JSON.stringify({ name: "app", devDependencies: { prettier: "^3.0.0" } }),
    ".prettierrc.js": "module.exports = { singleQuote: true };\n",
    "app/untouched.js": 'export const a = "not formatted"\n',
    "app/controllers/build-servers.js": "export default class {}\n",
  });
  mkdirSync(join(directory, "node_modules"));
  symlinkSync(
    join(import.meta.dirname, "../node_modules/prettier"),
    join(directory, "node_modules/prettier"),
  );
  mkdirSync(join(directory, "node_modules/.bin"));
  symlinkSync(
    join(import.meta.dirname, "../node_modules/prettier/bin/prettier.cjs"),
    join(directory, "node_modules/.bin/prettier"),
  );
  commit(directory, "Start");

  write(directory, {
    "app/controllers/build-servers.js": `import { saveRecord } from "@warp-drive/legacy/compat/builders";

export default class {
  async save() {
    await this.store.request(saveRecord(this.store
      .createRecord('build-server', { name: this.newBuildServerName })));
  }
}
`,
  });
  commit(directory, "ember-upgrade: warp-drive");

  let app = new Project(directory);

  expect(changedFiles(app)).toEqual(["app/controllers/build-servers.js"]);
  expect(format.detect(app)).toBe(true);

  await format.run(app);

  expect(app.read("app/controllers/build-servers.js")).toMatchInlineSnapshot(`
    "import { saveRecord } from '@warp-drive/legacy/compat/builders';

    export default class {
      async save() {
        await this.store.request(
          saveRecord(
            this.store.createRecord('build-server', {
              name: this.newBuildServerName,
            }),
          ),
        );
      }
    }
    "
  `);
  expect(app.read("app/untouched.js")).toBe('export const a = "not formatted"\n');
  expect(format.detect(app)).toBe(false);
});
