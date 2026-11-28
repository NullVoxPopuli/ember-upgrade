import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { explicitInjections, routerServiceTransitions } from "#stages/ember-source/injections.js";

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
test("each implicit injection becomes a service on the classes and templates that read it", () => {
  let app = project({
    "app/initializers/session-service.js": `export function initialize(application) {
  application.inject('route', 'session', 'service:session');
  application.inject('controller', 'session', 'service:session');
}

export default { initialize };
`,
    "app/routes/admin.js": `import Route from '@ember/routing/route';

export default class AdminRoute extends Route {
  beforeModel() {
    if (!this.session.isAuthenticated) this.transitionTo('login');
  }
}
`,
    "app/routes/index.js": `import Route from '@ember/routing/route';

export default class IndexRoute extends Route {}
`,
    "app/templates/admin/index.hbs": "{{#if this.session.isAuthenticated}}Hi{{/if}}\n",
  });

  expect(explicitInjections(app).map((injection) => injection.type)).toEqual([
    "route",
    "controller",
  ]);

  let files = app.files(["app/**/*.*"]);

  expect(Object.fromEntries(files.map((file) => [file, app.read(file)]))).toMatchInlineSnapshot(`
    {
      "app/controllers/admin/index.js": "import Controller from '@ember/controller';
    import { service } from '@ember/service';

    export default class AdminIndexController extends Controller {
      @service session;
    }
    ",
      "app/initializers/session-service.js": "export function initialize(application) {
    }

    export default { initialize };
    ",
      "app/routes/admin.js": "import Route from '@ember/routing/route';
    import { service } from '@ember/service';

    export default class AdminRoute extends Route {
      @service session;

      beforeModel() {
        if (!this.session.isAuthenticated) this.transitionTo('login');
      }
    }
    ",
      "app/routes/index.js": "import Route from '@ember/routing/route';

    export default class IndexRoute extends Route {}
    ",
      "app/templates/admin/index.hbs": "{{#if this.session.isAuthenticated}}Hi{{/if}}
    ",
    }
  `);
});

/**
 * From documize/community (AGPL-3.0), app/initializers/event-bus.js and app/mixins/notifier.js, shortened.
 */
test("a mixin that reads an injected property declares the service", () => {
  let app = project({
    "app/initializers/event-bus.js": `export function initialize(application) {
    application.inject('mixin', 'eventBus', 'service:eventBus');
}

export default { name: 'eventBus', initialize: initialize };
`,
    "app/mixins/notifier.js": `import Mixin from '@ember/object/mixin';
import EmberObject from '@ember/object';

const Message = EmberObject.create({ text: '' });

export default Mixin.create({
	notifySuccess(msg) {
        this.eventBus.publish('notifyUser', msg, 'success');
	},
});
`,
  });

  explicitInjections(app);

  expect(app.read("app/mixins/notifier.js")).toMatchInlineSnapshot(`
    "import Mixin from '@ember/object/mixin';
    import EmberObject from '@ember/object';
    import { service } from '@ember/service';

    const Message = EmberObject.create({ text: '' });

    export default Mixin.create({
      eventBus: service(),
    	notifySuccess(msg) {
            this.eventBus.publish('notifyUser', msg, 'success');
    	},
    });
    "
  `);
});

test("routes and controllers that read the store declare it, as ember-data stopped injecting it", () => {
  let app = project({
    "package.json": JSON.stringify({ devDependencies: { "ember-data": "~3.28.0" } }),
    "app/routes/addons.js": `import Route from '@ember/routing/route';

export default class AddonsRoute extends Route {
  model() {
    return this.store.findAll('addon');
  }
}
`,
  });

  explicitInjections(app);

  expect(app.read("app/routes/addons.js")).toMatchInlineSnapshot(`
    "import Route from '@ember/routing/route';
    import { service } from '@ember/service';

    export default class AddonsRoute extends Route {
      @service store;

      model() {
        return this.store.findAll('addon');
      }
    }
    "
  `);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("the transitions of routes and controllers go through the router service", () => {
  let app = project({
    "app/controllers/addons/correct.js": `import Controller from '@ember/controller';
import { action } from '@ember/object';

export default class CorrectController extends Controller {
  @action
  cancel() {
    this.transitionToRoute('addons.show', this.model.name);
  }
}
`,
  });

  routerServiceTransitions(app);

  expect(app.read("app/controllers/addons/correct.js")).toMatchInlineSnapshot(`
    "import Controller from '@ember/controller';
    import { action } from '@ember/object';
    import { service } from '@ember/service';

    export default class CorrectController extends Controller {
      @service router;

      @action
      cancel() {
        this.router.transitionTo('addons.show', this.model.name);
      }
    }
    "
  `);
});

/**
 * From emberobserver/client (MIT), shortened.
 */
test("an abort right before a redirect goes, because the router service replaces the transition", () => {
  let app = project({
    "app/routes/admin/review.js": `import Route from '@ember/routing/route';

export default class ReviewRoute extends Route {
  redirect(model, transition) {
    if (!transition.to.queryParams.list) {
      transition.abort();
      return this.replaceWith('admin.review.index', { queryParams: { list: 'needing-review' } });
    }
  }
}
`,
  });

  routerServiceTransitions(app);

  expect(app.read("app/routes/admin/review.js")).toMatchInlineSnapshot(`
    "import Route from '@ember/routing/route';
    import { service } from '@ember/service';

    export default class ReviewRoute extends Route {
      @service router;

      redirect(model, transition) {
        if (!transition.to.queryParams.list) {
          return this.router.replaceWith('admin.review.index', { queryParams: { list: 'needing-review' } });
        }
      }
    }
    "
  `);
});
