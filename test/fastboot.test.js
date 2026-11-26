import { expect, test } from "vitest";

import { withoutFastBootService } from "#stages/vite/fastboot.js";

/**
 * From ember-learn/ember-website app/controllers/community/meetups/index.ts (MIT), shortened.
 */
test("isFastBoot becomes import.meta.env.SSR, and the service goes when nothing else reads it", () => {
  expect(
    withoutFastBootService(
      `import Controller from '@ember/controller';
import { type Registry as Services, service } from '@ember/service';

export default class CommunityMeetupsIndexController extends Controller {
  @service declare fastboot: Services['fastboot'];

  constructor() {
    super(...arguments);

    // @ts-expect-error: Incorrect type
    if (!this.fastboot.isFastBoot) {
      void import('maplibre-gl');
    }
  }
}
`,
      "app/controllers/community/meetups/index.ts",
    ),
  ).toMatchInlineSnapshot(`
    {
      "output": "import Controller from '@ember/controller';

    export default class CommunityMeetupsIndexController extends Controller {

      constructor() {
        super(...arguments);

        if (!import.meta.env.SSR) {
          void import('maplibre-gl');
        }
      }
    }
    ",
      "remaining": false,
      "removed": [],
      "statusCodes": 0,
    }
  `);
});

/**
 * From ember-learn/ember-website app/routes/not-found.ts (MIT).
 */
test("the service stays when the code reads more than isFastBoot", () => {
  expect(
    withoutFastBootService(
      `import Route from '@ember/routing/route';
import { type Registry as Services, service } from '@ember/service';

export default class NotFoundRoute extends Route {
  @service declare fastboot: Services['fastboot'];

  beforeModel(): void {
    // @ts-expect-error: Incorrect type
    if (!this.fastboot.isFastBoot) {
      return;
    }

    // @ts-expect-error: Incorrect type
    this.fastboot.response.statusCode = 404;
  }
}
`,
      "app/routes/not-found.ts",
    ),
  ).toMatchInlineSnapshot(`
    {
      "output": "import Route from '@ember/routing/route';
    import { setStatusCode } from 'vite-ember-ssr/client';

    export default class NotFoundRoute extends Route {

      beforeModel(): void {
        if (!import.meta.env.SSR) {
          return;
        }

        setStatusCode(404);
      }
    }
    ",
      "remaining": false,
      "removed": [],
      "statusCodes": 1,
    }
  `);
});

/**
 * From ember-learn/ember-website app/routes/not-found.ts (MIT).
 */
test("the status code of a FastBoot response becomes setStatusCode of vite-ember-ssr", () => {
  expect(
    withoutFastBootService(
      `import Route from '@ember/routing/route';
import { type Registry as Services, service } from '@ember/service';

export default class NotFoundRoute extends Route {
  @service declare fastboot: Services['fastboot'];

  beforeModel(): void {
    // @ts-expect-error: Incorrect type
    if (!this.fastboot.isFastBoot) {
      return;
    }

    // @ts-expect-error: Incorrect type
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    this.fastboot.response.statusCode = 404;
  }
}
`,
      "app/routes/not-found.ts",
    ),
  ).toMatchInlineSnapshot(`
    {
      "output": "import Route from '@ember/routing/route';
    import { setStatusCode } from 'vite-ember-ssr/client';

    export default class NotFoundRoute extends Route {

      beforeModel(): void {
        if (!import.meta.env.SSR) {
          return;
        }

        setStatusCode(404);
      }
    }
    ",
      "remaining": false,
      "removed": [],
      "statusCodes": 1,
    }
  `);
});

test("a read of the service inside another statement stays for the user", () => {
  let result = withoutFastBootService(
    `export default class extends Route {
  @service fastboot;

  model() {
    return this.store.findAll('post').then(() => this.fastboot.deferRendering());
  }
}
`,
    "app/routes/posts.js",
  );

  expect([result.remaining, result.removed]).toEqual([true, []]);
});
