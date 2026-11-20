import { expect, test } from "vitest";

import { transform } from "#stages/addons/ember-fetch.js";

test("the default import becomes the global fetch", () => {
  expect(
    transform(
      `import Route from '@ember/routing/route';
import fetch from 'fetch';

export default class extends Route {
  model() {
    return fetch('/omg.json').then((response) => response.json());
  }
}
`,
      "app/routes/index.js",
    ),
  ).toBe(`import Route from '@ember/routing/route';

export default class extends Route {
  model() {
    return fetch('/omg.json').then((response) => response.json());
  }
}
`);
});

test("a renamed import keeps its name", () => {
  expect(
    transform(
      `import emberFetch, { Headers } from 'fetch';\n\nemberFetch('/x', { headers: new Headers() });\n`,
      "app/x.js",
    ),
  ).toBe(`const emberFetch = fetch;\n\nemberFetch('/x', { headers: new Headers() });\n`);
});

test("the error helpers become local functions", () => {
  expect(
    transform(
      `import { isUnauthorizedResponse, isServerErrorResponse as serverError } from 'ember-fetch/errors';\n`,
      "app/x.ts",
    ),
  ).toBe(
    `const isUnauthorizedResponse = (response: Response) => response.status === 401;\nconst serverError = (response: Response) => response.status >= 500 && response.status < 600;\n`,
  );
});

test("an import with no global stays for the user", () => {
  let source = `import AdapterFetch from 'ember-fetch/mixins/adapter-fetch';\n`;

  expect(transform(source, "app/adapters/application.js")).toBe(source);
});
