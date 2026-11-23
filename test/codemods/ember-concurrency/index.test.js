import { expect, test } from "vitest";

import { modernizeTasks } from "#codemods/ember-concurrency/index.js";

/**
 * From emberobserver/client (MIT), shortened.
 */
test("a decorator with a task becomes a field with an async arrow function", () => {
  let source = `import Component from '@glimmer/component';
import { task, timeout } from 'ember-concurrency';

export default class AdminAddon extends Component {
  @(task(function* () {
    try {
      yield this.addon.save();
    } catch (e) {
      window.alert('Failed to save addon');
    }
  }).drop())
  saveAddon;

  @task(function* (query, options) {
    let data = yield this.fetch.perform();
    yield timeout(2000);
    return data;
  })
  search;

  <template>{{this.saveAddon.isRunning}}</template>
}
`;

  expect(modernizeTasks(source, "app/components/admin-addon.gjs")).toMatchInlineSnapshot(`
    {
      "source": "import Component from '@glimmer/component';
    import { task, timeout } from 'ember-concurrency';

    export default class AdminAddon extends Component {
      saveAddon = task({ drop: true }, async () => {
        try {
          await this.addon.save();
        } catch (e) {
          window.alert('Failed to save addon');
        }
      });

      search = task(async (query, options) => {
        let data = await this.fetch.perform();
        await timeout(2000);
        return data;
      });

      <template>{{this.saveAddon.isRunning}}</template>
    }
    ",
      "unreadable": [],
    }
  `);
});

test("the task decorators, the field form, and the options", () => {
  let source = `import Service from '@ember/service';
import { task as concurrentTask } from 'ember-concurrency';
import { dropTask, restartableTask } from 'ember-concurrency-decorators';

export default class Sounds extends Service {
  @dropTask
  *play(sound) {
    yield sound.play();
  }

  @restartableTask({ maxConcurrency: 3 })
  *search() {
    let value = yield a || b;
    let list = [1, 2].map(function* () {
      yield 1;
    });
  }

  archive = concurrentTask(function* () {
    yield this.task.save();
  }).enqueue().maxConcurrency(2);
}
`;

  expect(modernizeTasks(source, "app/services/sounds.js")).toMatchInlineSnapshot(`
    {
      "source": "import Service from '@ember/service';
    import { task as concurrentTask } from 'ember-concurrency';

    export default class Sounds extends Service {
      play = concurrentTask({ drop: true }, async (sound) => {
        await sound.play();
      });

      search = concurrentTask({ restartable: true, maxConcurrency: 3 }, async () => {
        let value = await (a || b);
        let list = [1, 2].map(function* () {
          yield 1;
        });
      });

      archive = concurrentTask({ enqueue: true, maxConcurrency: 2 }, async () => {
        await this.task.save();
      });
    }
    ",
      "unreadable": [],
    }
  `);
});

test("a task in a classic class, and a task that reads arguments, stay as they are", () => {
  let source = `import Service from '@ember/service';
import { task } from 'ember-concurrency';

export const A = Service.extend({
  play: task(function* () {}).drop(),
});

export class B extends Service {
  play = task(function* () {
    yield this.run(arguments[0]);
  });
}
`;

  expect(modernizeTasks(source, "app/services/a.js")).toMatchInlineSnapshot(`
    {
      "source": "import Service from '@ember/service';
    import { task } from 'ember-concurrency';

    export const A = Service.extend({
      play: task(function* () {}).drop(),
    });

    export class B extends Service {
      play = task(function* () {
        yield this.run(arguments[0]);
      });
    }
    ",
      "unreadable": [
        "the task play in a classic class",
        "a task reads \`arguments\`, which an arrow function does not have",
      ],
    }
  `);
});
