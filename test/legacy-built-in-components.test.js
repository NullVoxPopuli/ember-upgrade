import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import stage, { isScrollOnlyLink } from "#stages/addons/legacy-built-in-components.js";

/**
 * From ember-learn/deprecation-app app/components/link-to.js (MIT).
 */
const LINK = `import { LinkComponent } from '@ember/legacy-built-in-components';

export default class CustomLinkComponent extends LinkComponent {
  click() {
    if (window.scrollTo) {
      window.scrollTo(0, 0);
    }
  }
}
`;

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

test("a LinkTo subclass that scrolls to the top becomes a listener of the application route", async () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: { "@ember/legacy-built-in-components": "^0.4.2" },
    }),
    "app/components/link-to.js": LINK,
    "app/components/main-layout.gjs": `import LinkTo from './link-to';\n\n<template><LinkTo @route="index">Home</LinkTo></template>\n`,
    "config/environment.js": `module.exports = function () { return { modulePrefix: 'deprecation-app' }; };\n`,
  });

  expect(stage.detect(app)).toBe(true);
  expect((await stage.check(app)).blockers).toEqual([]);

  await stage.run(app);

  expect(app.has("app/components/link-to.js")).toBe(false);
  expect(app.read("app/components/main-layout.gjs")).toMatchInlineSnapshot(`
    "import { LinkTo } from '@ember/routing';

    <template><LinkTo @route="index">Home</LinkTo></template>
    "
  `);
  expect(app.read("app/routes/application.js")).toMatchInlineSnapshot(`
    "import Route from '@ember/routing/route';
    import { service } from '@ember/service';

    export default class ApplicationRoute extends Route {
      @service router;

      constructor() {
        super(...arguments);

        this.router.on('routeDidChange', () => {
          if (window.scrollTo) {
            window.scrollTo(0, 0);
          }
        });
      }
    }
    "
  `);
  expect(stage.detect(app)).toBe(false);
});

test("another use of the addon stops the stage", async () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: { "@ember/legacy-built-in-components": "^0.4.2" },
    }),
    "app/components/my-input.js": `import { TextField } from '@ember/legacy-built-in-components';\n\nexport default class extends TextField {}\n`,
  });

  expect((await stage.check(app)).blockers.map((finding) => finding.where)).toEqual([
    ["app/components/my-input.js"],
  ]);
});

test("a LinkTo subclass that does more than scroll is not converted", () => {
  expect(
    isScrollOnlyLink(
      LINK.replace("window.scrollTo(0, 0);", "window.scrollTo(0, 0);\n      this.track();"),
      "app/components/link-to.js",
    ),
  ).toBe(false);
});
