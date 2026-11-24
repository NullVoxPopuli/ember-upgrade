import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The tests write their projects to the temporary directory, and do not delete them.
 * The test workers start after this, so `os.tmpdir()` gives them one directory for the run, which goes at the end.
 */
export default function setup() {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-tests-"));

  process.env.TMPDIR = directory;

  return () => rmSync(directory, { recursive: true, force: true });
}
