import { expect, test } from "vitest";

import { stripTypes } from "#strip-types.js";

/**
 * From ember-app-scheduler 7.0.1 (MIT), shortened.
 */
test("the TypeScript syntax goes, and the JavaScript stays as it was written", () => {
  expect(
    stripTypes(
      `import type RouterService from '@ember/routing/router-service';
import { buildWaiter, Token } from '@ember/test-waiters';

interface Deferred {
  isResolved: boolean;
  promise: Promise<any>;
}

let _whenRouteDidChange: Deferred;
const waiter = buildWaiter('ember-app-scheduler-waiter');

const IS_FASTBOOT = typeof (<any>window).FastBoot !== 'undefined';

export function setupRouter(router: RouterService): void {
  let token = waiter.beginAsync() as Token;
}
`,
      "scheduler.ts",
    ),
  ).toMatchInlineSnapshot(`
    "import { buildWaiter } from '@ember/test-waiters';

    let _whenRouteDidChange;
    const waiter = buildWaiter('ember-app-scheduler-waiter');

    const IS_FASTBOOT = typeof ((window)).FastBoot !== 'undefined';

    export function setupRouter(router) {
      let token = waiter.beginAsync();
    }
    "
  `);
});

test("an enum stays TypeScript", () => {
  expect(stripTypes("enum State { Idle }\n", "a.ts")).toBeUndefined();
});
