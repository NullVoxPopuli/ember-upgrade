import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import documentTitle from "#stages/document-title/index.js";

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
 * From emberobserver/client (MIT), shortened.
 */
test("each titleToken becomes a page-title call in the route's template", async () => {
  let app = project({
    "package.json": JSON.stringify({
      devDependencies: {
        "ember-cli-document-title-northm": "^1.0.2",
        "ember-page-title": "^9.0.3",
      },
    }),
    "app/routes/application.js": `import Route from '@ember/routing/route';

export default class ApplicationRoute extends Route {
  model() {
    return {};
  }

  title(tokens) {
    let tokenStr = tokens.join(' | ');
    if (tokenStr) {
      return \`\${tokenStr} - Ember Observer\`;
    } else {
      return 'Ember Observer';
    }
  }
}
`,
    "app/routes/admin.js": `import Route from '@ember/routing/route';

export default class AdminRoute extends Route {
  titleToken() {
    return 'Admin';
  }
}
`,
    "app/routes/addons/show.js": `import Route from '@ember/routing/route';

export default class ShowRoute extends Route {
  titleToken(model) {
    return model.addon.get('name');
  }

  afterModel() {
    this.emberVersions.fetch();
  }
}
`,
    "app/templates/application.hbs": "<main>{{outlet}}</main>\n",
    "app/templates/addons/show.hbs": "<AddonDetails @addon={{@model.addon}} />\n",
  });

  expect((await documentTitle.check(app)).blockers).toEqual([]);

  await documentTitle.run(app);

  let files = app.files(["app/**/*.*"]);

  expect(Object.fromEntries(files.map((file) => [file, app.read(file)]))).toMatchInlineSnapshot(`
    {
      "app/routes/addons/show.js": "import Route from '@ember/routing/route';

    export default class ShowRoute extends Route {
      afterModel() {
        this.emberVersions.fetch();
      }
    }
    ",
      "app/routes/admin.js": "import Route from '@ember/routing/route';

    export default class AdminRoute extends Route {
    }
    ",
      "app/routes/application.js": "import Route from '@ember/routing/route';

    export default class ApplicationRoute extends Route {
      model() {
        return {};
      }
    }
    ",
      "app/services/page-title.js": "import PageTitleService from 'ember-page-title/services/page-title';

    /**
     * ember-cli-document-title built the title with the application route's title(tokens),
     * from each route's titleToken, outermost first. The route templates give those titles now.
     */
    export default class PageTitle extends PageTitleService {
      toString() {
        return title(this.visibleTokens.map((token) => token.title).filter(Boolean));
      }
    }

    function title(tokens) {
      let tokenStr = tokens.join(' | ');
      if (tokenStr) {
        return \`\${tokenStr} - Ember Observer\`;
      } else {
        return 'Ember Observer';
      }
    }
    ",
      "app/templates/addons/show.hbs": "{{page-title @model.addon.name}}
    <AddonDetails @addon={{@model.addon}} />
    ",
      "app/templates/admin.hbs": "{{page-title "Admin"}}
    {{outlet}}
    ",
      "app/templates/application.hbs": "<main>{{outlet}}</main>
    ",
    }
  `);
  expect(app.packageJson.devDependencies).toEqual({ "ember-page-title": "^9.0.3" });
});

test("a titleToken that reads more than the model blocks the stage", async () => {
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-cli-document-title": "^1.0.0" } }),
    "app/routes/user.js": `import Route from '@ember/routing/route';

export default class UserRoute extends Route {
  titleToken(model) {
    return this.intl.t('user', { name: model.name });
  }
}
`,
  });

  expect((await documentTitle.check(app)).blockers.map((finding) => finding.where)).toEqual([
    ["app/routes/user.js"],
  ]);
});
