/**
 * Runs the built CLI from a folder with no node_modules above it,
 * so a missing bundled dependency fails here and not on a user's machine.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = mkdtempSync(join(tmpdir(), "ember-upgrade-bundle-"));
let cli = join(root, "dist/cli.js");
let app = join(root, "app");

cpSync("dist", join(root, "dist"), { recursive: true });
mkdirSync(join(app, "app"), { recursive: true });
writeFileSync(join(app, "package.json"), `{ "name": "app" }`);
writeFileSync(
  join(app, "app/app.js"),
  `import Ember from 'ember';\nexport default Ember.Application.extend();\n`,
);

execFileSync(process.execPath, [cli, app, "--only", "ember-globals", "--no-commit"], {
  stdio: "inherit",
});

let output = readFileSync(join(app, "app/app.js"), "utf8");
let expected = `import Application from '@ember/application';\nexport default Application.extend();\n`;

if (output !== expected) {
  console.error(`Unexpected output:\n${output}`);
  process.exit(1);
}

console.log(`The bundle works without node_modules (${root}).`);
