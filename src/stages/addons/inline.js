import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

/**
 * @typedef {object} Inline
 * @property {string} name the addon
 * @property {string} label
 * @property {Record<string, string>} files the files to write, by path in the project
 * @property {Record<string, string>} imports each import specifier of the addon, and the file that replaces it
 * @property {Record<string, string>} [moves] files of the app that move, from and to
 * @property {Record<string, string>} [dependencies] packages that the new files import, with a fallback version
 * @property {string} note what the person needs to know about the moved code
 */

const SOURCES = ["{app,tests}/**/*.{js,ts,gjs,gts}"];

/**
 * @param {string} from the importing file
 * @param {string} to the imported file
 */
function specifier(from, to) {
  let path = relative(dirname(from), to).split("\\").join("/");

  return path.startsWith(".") ? path : `./${path}`;
}

/**
 * Moves a small v1 addon into the app: ember.nvp builds without ember-cli, so v1 addons do not load,
 * and these addons have no v2 release.
 * The new files keep the addon's code, with the deprecated APIs replaced.
 *
 * @param {Inline} inline
 * @returns {import('#types.js').Stage}
 */
export function inlineStage(inline) {
  let targets = Object.keys(inline.files).concat(Object.values(inline.moves ?? {}));

  return {
    name: inline.name,
    label: inline.label,

    detect(project) {
      return Boolean(project.dependency(inline.name));
    },

    async check(project) {
      let taken = targets.filter((file) => project.has(file));
      let missing = Object.keys(inline.moves ?? {}).filter((file) => !project.has(file));

      /** @type {import('#types.js').Finding[]} */
      let blockers = [];

      if (taken.length > 0) {
        blockers.push({
          title: `Files that the ${inline.name} code would replace`,
          where: taken,
          action: "Rename them, or move the addon's code into the app by hand.",
        });
      }

      if (missing.length > 0) {
        blockers.push({
          title: `Files that the ${inline.name} stage moves`,
          where: missing,
          action: "Run the stage before the template-tag stage, or move the addon's code by hand.",
        });
      }

      return { blockers, todo: [] };
    },

    async run(project) {
      /**
       * @param {string} file
       * @param {string} contents
       */
      let write = (file, contents) => {
        mkdirSync(join(project.directory, dirname(file)), { recursive: true });
        project.write(file, contents);
      };

      for (let [file, contents] of Object.entries(inline.files)) write(file, contents);

      for (let [from, to] of Object.entries(inline.moves ?? {})) {
        write(to, project.read(from));
        rmSync(join(project.directory, from));
      }

      for (let file of project.files(SOURCES)) {
        let source = project.read(file);
        let output = source;

        for (let [from, to] of Object.entries(inline.imports)) {
          output = output.split(`'${from}'`).join(`'${specifier(file, to)}'`);
          output = output.split(`"${from}"`).join(`"${specifier(file, to)}"`);
        }

        if (output !== source) project.write(file, output);
      }

      editPackageJson(project, (pkg) => {
        removeDependency(pkg, inline.name);

        for (let [name, fallback] of Object.entries(inline.dependencies ?? {})) {
          if (!project.dependency(name)) {
            setDependency(pkg, name, `^${published(name)?.version ?? fallback}`);
          }
        }
      });

      recordProgress(project, {
        id: inline.name,
        status: "moved into the app",
        note: `${inline.note} The code is now in ${targets.join(", ")}.`,
      });

      return [];
    },
  };
}

/**
 * @param {string} name
 * @param {string} license
 */
function origin(name, license = "MIT") {
  return `/**\n * From ${name} (${license}). ember-upgrade moved it into the app, because it has no v2 release.\n */\n`;
}

export const emberEventHelpers = inlineStage({
  name: "ember-event-helpers",
  label: "Move ember-event-helpers into the app",
  files: {
    "app/helpers/prevent-default.js": `${origin("ember-event-helpers")}import { helper } from '@ember/component/helper';

export function preventDefault([handler]) {
  return function (event) {
    event.preventDefault();

    if (handler) handler(event);
  };
}

export default helper(preventDefault);
`,
    "app/helpers/stop-propagation.js": `${origin("ember-event-helpers")}import { helper } from '@ember/component/helper';

export function stopPropagation([handler]) {
  return function (event) {
    event.stopPropagation();

    if (handler) handler(event);
  };
}

export default helper(stopPropagation);
`,
  },
  imports: {
    "ember-event-helpers/helpers/prevent-default": "app/helpers/prevent-default.js",
    "ember-event-helpers/helpers/stop-propagation": "app/helpers/stop-propagation.js",
  },
  note: "ember-event-helpers is moved into the app. `(fn)` with an event handler that calls `event.preventDefault()` does the same without a helper.",
});

export const emberAutoFocus = inlineStage({
  name: "@zestia/ember-auto-focus",
  label: "Move @zestia/ember-auto-focus into the app",
  files: {
    "app/modifiers/auto-focus.js": `${origin("@zestia/ember-auto-focus")}import { next, scheduleOnce } from '@ember/runloop';
import Modifier from 'ember-modifier';

export default class AutoFocusModifier extends Modifier {
  didSetup = false;

  modify(element, positional, named) {
    if (this.didSetup) {
      return;
    }

    this.didSetup = true;

    if (named.disabled) {
      return;
    }

    let [selector] = positional;

    if (selector) {
      element = element.querySelector(selector);
    }

    if (!element) {
      return;
    }

    scheduleOnce('afterRender', this, afterRender, element);
  }
}

function afterRender(element) {
  if (element.contains(document.activeElement)) {
    return;
  }

  focus(element);
}

export function focus(element) {
  element.dataset.programmaticallyFocused = 'true';
  element.focus();
  next(() => delete element.dataset.programmaticallyFocused);
}
`,
  },
  imports: {
    "@zestia/ember-auto-focus/modifiers/auto-focus": "app/modifiers/auto-focus.js",
    "@zestia/ember-auto-focus/utils/focus": "app/modifiers/auto-focus.js",
  },
  dependencies: { "ember-modifier": "4.3.0" },
  note: "@zestia/ember-auto-focus is moved into the app. Its npm package moved to GitHub Packages.",
});

export const emberErrorRoute = inlineStage({
  name: "ember-error-route",
  label: "Move ember-error-route into the app",
  files: {
    "app/utils/error-route.js": `${origin("ember-error-route")}import Route from '@ember/routing/route';
import { service } from '@ember/service';

/**
 * The route for URLs that no other route matches, and a generic error page:
 * \`this.router.replaceWith('catch-all', { transition, title: 'Something failed' })\`.
 * The error substates of Ember do not change the URL, so the back button of the browser goes to the wrong page.
 */
export default class ErrorRoute extends Route {
  @service router;

  serialize({ transition }) {
    let path = this.urlForRouteInfo(transition.to);
    let { rootURL } = this.router;

    if (path.startsWith(rootURL)) {
      path = path.slice(rootURL.length);
    }

    return { path };
  }

  urlForRouteInfo(routeInfo) {
    let params = [];

    for (let info of allRouteInfos(routeInfo).reverse()) {
      for (let paramName of info.paramNames) {
        params.push(info.params[paramName]);
      }
    }

    return this.router.urlFor(routeInfo.name, ...params, { queryParams: routeInfo.queryParams });
  }
}

function allRouteInfos(routeInfo) {
  let result = [];

  for (let info = routeInfo; info; info = info.parent) {
    result.push(info);
  }

  return result;
}
`,
  },
  imports: { "ember-error-route": "app/utils/error-route.js" },
  note: "ember-error-route is moved into the app. It reads rootURL from the router service now, not from config/environment.",
});

export const emberCliHead = inlineStage({
  name: "ember-cli-head",
  label: "Move ember-cli-head into the app",
  files: {
    "app/services/head-data.js": `${origin("ember-cli-head")}import Service from '@ember/service';

export default class HeadData extends Service {}
`,
    "app/components/head-content.js": `${origin("ember-cli-head")}import Component from '@glimmer/component';
import { service } from '@ember/service';

export default class HeadContent extends Component {
  @service('head-data') model;
}
`,
    "app/components/head-layout.gjs": `${origin("ember-cli-head")}import HeadContent from './head-content.js';

const head = document.head;

<template>
  {{#in-element head insertBefore=null}}
    <HeadContent />
  {{/in-element}}
</template>
`,
  },
  moves: { "app/templates/head.hbs": "app/components/head-content.hbs" },
  imports: {
    "ember-cli-head/components/head-layout": "app/components/head-layout.gjs",
    "ember-cli-head/services/head-data": "app/services/head-data.js",
  },
  note:
    "ember-cli-head is moved into the app: <HeadLayout /> renders app/components/head-content.hbs into <head>. " +
    "It no longer removes a <head> that FastBoot rendered.",
});

export const emberApiActions = inlineStage({
  name: "@mainmatter/ember-api-actions",
  label: "Move @mainmatter/ember-api-actions into the app",
  files: {
    "app/utils/api-action.js": `${origin("@mainmatter/ember-api-actions")}export async function apiAction(
  record,
  { requestType = 'updateRecord', method, path, data, adapterOptions },
) {
  let modelName = record.constructor.modelName;
  let adapter = record.store.adapterFor(modelName);
  let snapshot = record._createSnapshot();

  if (adapterOptions) {
    snapshot.adapterOptions = adapterOptions;
  }

  let baseUrl = adapter.buildURL(modelName, record.id, snapshot, requestType);

  return await adapter.ajax(addPath(baseUrl, path), method, { data });
}

export async function adapterAction(
  adapter,
  modelName,
  { requestType = 'createRecord', method, path, data, adapterOptions },
) {
  let baseUrl = adapter.buildURL(modelName, null, { adapterOptions }, requestType);

  return await adapter.ajax(addPath(baseUrl, path), method, { data });
}

function addPath(baseUrl, path) {
  if (!path) return baseUrl;

  let url = new URL(baseUrl, location.href);
  let [pathname, search] = path.split('?', 2);

  url.pathname += \`/\${pathname}\`;

  if (search) {
    new URLSearchParams(search).forEach((value, name) => {
      url.searchParams.append(name, value);
    });
  }

  return url.href;
}
`,
  },
  imports: { "@mainmatter/ember-api-actions": "app/utils/api-action.js" },
  note:
    "@mainmatter/ember-api-actions is moved into the app. It uses the adapter of the model. " +
    "With WarpDrive request builders, `store.request()` does the same without an adapter.",
});
