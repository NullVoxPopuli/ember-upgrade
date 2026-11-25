import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import defaultQueryParams from "#stages/default-query-params/index.js";

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
 * The files are from emberobserver/client, shortened.
 */
test("the URLs that tests expect lose the query params with the default value", async () => {
  let app = project({
    "app/controllers/index.js": `import Controller from '@ember/controller';

export default class IndexController extends Controller {
  queryParams = ['query', 'searchReadmes'];
  query = '';
  searchReadmes = false;
}
`,
    "tests/acceptance/header-search-test.js": `import { currentURL } from '@ember/test-helpers';

test('Header search has option to full search', async function (assert) {
  assert.equal(
    currentURL(),
    '/?query=test&searchReadmes=false',
    'Perform full search takes to index with correct query'
  );
  assert.equal(currentURL(), '/?searchReadmes=false');
  assert.equal(currentURL(), '/?query=test&searchReadmes=true');
  assert.equal(currentURL(), '/', 'searchReadmes=false');
});
`,
  });

  expect(defaultQueryParams.detect(app)).toBe(true);

  await defaultQueryParams.run(app);

  expect(app.read("tests/acceptance/header-search-test.js")).toMatchInlineSnapshot(`
    "import { currentURL } from '@ember/test-helpers';

    test('Header search has option to full search', async function (assert) {
      assert.equal(
        currentURL(),
        '/?query=test',
        'Perform full search takes to index with correct query'
      );
      assert.equal(currentURL(), '/');
      assert.equal(currentURL(), '/?query=test&searchReadmes=true');
      assert.equal(currentURL(), '/', 'searchReadmes=false');
    });
    "
  `);
  expect(defaultQueryParams.detect(app)).toBe(false);
});
