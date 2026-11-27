import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { installedAddonTree, resolvePackage } from "#installed.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";
import { isObsoleteAddon, removeFromCode } from "./removals.js";

/** @typedef {import('#project.js').Project} Project */

/**
 * @typedef {object} Inline
 * @property {string} name the addon
 * @property {string} label
 * @property {Record<string, string>} files the files to write, by path in the project
 * @property {Record<string, string>} [defaults] files to write only when the app has none, because the app can override them
 * @property {(project: Project) => Record<string, string> | undefined} [generated] files made from the installed package; undefined when the stage cannot make them
 * @property {Record<string, string>} imports each import specifier of the addon, and the file that replaces it
 * @property {Record<string, string>} [moves] files of the app that move, from and to
 * @property {Record<string, string>} [dependencies] packages that the new files import, with a fallback version
 * @property {Record<string, string>} [ranges] packages that the new files import, with the range that the addon asked for
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
 * @param {Project} project
 * @param {string} file such as `app/templates/head.hbs`
 * @returns {string | undefined} the app's file, or the file of an addon's app tree that ember-cli merged into the app,
 * such as the head template of guidemaker
 */
function moveSource(project, file) {
  if (project.has(file)) return project.read(file);

  for (let { directory, manifest } of installedAddonTree(project)) {
    if (!manifest.keywords?.includes("ember-addon")) continue;

    let path = join(directory, file);

    if (existsSync(path)) return readFileSync(path, "utf8");
  }
}

/**
 * @param {string} name the addon
 * @param {string | undefined} version
 * @param {string | undefined} license
 * @returns {string[]} the lines of the header of a copied file
 */
function originLines(name, version, license) {
  return [
    `Copied from ${name}${version ? ` ${version}` : ""}${license ? ` (${license})` : ""} by ember-upgrade.`,
    `${name} is a v1 addon with no v2 release,`,
    "and the Vite build does not load v1 addons.",
    "To use the library again, once it has a v2 release:",
    `add ${name} to package.json, import its modules`,
    `from ${name} again, and delete the files`,
    "that have this comment.",
  ];
}

/**
 * @param {string} file
 * @param {string} contents
 * @param {string[]} lines
 * @returns {string} the contents with the header in the comment syntax of the file; HTML and JSON stay as they are
 */
export function withOrigin(file, contents, lines) {
  if (/\.(js|ts|gjs|gts)$/.test(file)) {
    return `/**\n${lines.map((line) => ` * ${line}`).join("\n")}\n */\n${contents}`;
  }

  if (/\.hbs$/.test(file))
    return `{{!--\n${lines.map((line) => `  ${line}`).join("\n")}\n--}}\n${contents}`;
  if (/\.(css|scss|sass|less)$/.test(file)) {
    return `/*\n${lines.map((line) => ` * ${line}`).join("\n")}\n */\n${contents}`;
  }

  return contents;
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
  let targets = Object.keys(inline.files).concat(
    Object.values(inline.moves ?? {}),
    Object.values(inline.imports).filter(
      (file) => !(file in inline.files) && !(file in (inline.defaults ?? {})),
    ),
  );
  let defaults = Object.keys(inline.defaults ?? {});

  return {
    name: inline.name,
    label: inline.label,

    detect(project) {
      return Boolean(project.dependency(inline.name));
    },

    async check(project) {
      let taken = targets.filter((file) => project.has(file));
      let missing = Object.keys(inline.moves ?? {}).filter(
        (file) => moveSource(project, file) === undefined,
      );

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

      if (inline.generated && !inline.generated(project)) {
        blockers.push({
          title: `The code of ${inline.name} that the stage cannot convert`,
          where: [`node_modules/${inline.name}`],
          action: "Move the package's code into the app by hand.",
        });
      }

      return { blockers, todo: [] };
    },

    async run(project) {
      let installed = resolvePackage(project.directory, inline.name);
      let manifest = installed
        ? JSON.parse(readFileSync(join(installed, "package.json"), "utf8"))
        : undefined;
      let lines = originLines(
        inline.name,
        manifest?.version,
        typeof manifest?.license === "string" ? manifest.license : undefined,
      );

      /**
       * @param {string} file
       * @param {string} contents
       */
      let write = (file, contents) => {
        project.write(file, contents);
      };

      for (let [file, contents] of Object.entries(inline.files)) {
        write(file, withOrigin(file, contents, lines));
      }

      /**
       * The app's own files that a stage changes, such as ember-cli-build or the HTML of a contentFor hook, keep no header.
       */
      for (let [file, contents] of Object.entries(inline.generated?.(project) ?? {})) {
        write(file, project.has(file) ? contents : withOrigin(file, contents, lines));
      }

      for (let [file, contents] of Object.entries(inline.defaults ?? {})) {
        if (!project.has(file)) write(file, withOrigin(file, contents, lines));
      }

      for (let [from, to] of Object.entries(inline.moves ?? {})) {
        write(to, /** @type {string} */ (moveSource(project, from)));

        if (project.has(from)) rmSync(join(project.directory, from));
      }

      /**
       * The stage's own files keep the addon's code as it was, examples in comments too.
       */
      let own = new Set(targets.concat(defaults));

      for (let file of project.files(SOURCES)) {
        if (own.has(file)) continue;

        let source = project.read(file);
        let output = source;

        for (let [from, to] of Object.entries(inline.imports)) {
          output = output.split(`'${from}'`).join(`'${specifier(file, to)}'`);
          output = output.split(`"${from}"`).join(`"${specifier(file, to)}"`);
        }

        if (output !== source) project.write(file, output);
      }

      /**
       * The removal stages ran before the addon's code came into the app,
       * so the code of an obsolete dependency, such as `@classic`, goes now, and the dependency stays out.
       */
      let obsolete = Object.keys(inline.ranges ?? {}).filter((name) => isObsoleteAddon(name));

      for (let name of obsolete) removeFromCode(project, name);

      editPackageJson(project, (pkg) => {
        removeDependency(pkg, inline.name);

        for (let [name, fallback] of Object.entries(inline.dependencies ?? {})) {
          if (!project.dependency(name)) {
            setDependency(pkg, name, `^${published(name)?.version ?? fallback}`);
          }
        }

        for (let [name, range] of Object.entries(inline.ranges ?? {})) {
          if (!project.dependency(name) && !obsolete.includes(name))
            setDependency(pkg, name, range);
        }
      });

      recordProgress(project, {
        id: inline.name,
        status: "moved into the app",
        note: `${inline.note} The code is now in ${targets.concat(defaults).join(", ")}.`,
      });

      return [];
    },
  };
}

export const emberEventHelpers = inlineStage({
  name: "ember-event-helpers",
  label: "Move ember-event-helpers into the app",
  files: {
    "app/helpers/prevent-default.js": `import { helper } from '@ember/component/helper';

export function preventDefault([handler]) {
  return function (event) {
    event.preventDefault();

    if (handler) handler(event);
  };
}

export default helper(preventDefault);
`,
    "app/helpers/stop-propagation.js": `import { helper } from '@ember/component/helper';

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
    "app/modifiers/auto-focus.js": `import { next, scheduleOnce } from '@ember/runloop';
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
    "app/utils/error-route.js": `import Route from '@ember/routing/route';
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
  defaults: {
    "app/services/head-data.js": `import Service from '@ember/service';

export default class HeadData extends Service {}
`,
  },
  files: {
    "app/components/head-content.js": `import Component from '@glimmer/component';
import { service } from '@ember/service';

export default class HeadContent extends Component {
  @service('head-data') model;
}
`,
    "app/components/head-layout.gjs": `import HeadContent from './head-content.js';

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
    "app/utils/api-action.js": `export async function apiAction(
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

/**
 * Converts CommonJS that only has `exports.name = name;` statements to ES module syntax.
 *
 * @param {string} source
 * @returns {string | undefined} undefined when the code uses other CommonJS forms
 */
export function commonJsToEsm(source) {
  let output = source
    .replace(/^"use strict";\n/, "")
    .replace(/^Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);\n/m, "")
    .replace(/^exports\.default = ([\w$]+);$/gm, "export default $1;")
    .replace(/^exports\.([\w$]+) = \1;$/gm, "export { $1 };");

  if (/\b(exports|module\.exports|require)\b/.test(output.replace(/\/\*[^]*?\*\/|\/\/.*$/gm, "")))
    return;

  return output;
}

/**
 * @param {Project} project
 * @param {string} name a package that ships CommonJS
 * @param {string} file its entry file
 * @param {string} target
 */
function convertedPackage(project, name, file, target) {
  let path = join("node_modules", name, file);

  if (!project.has(path)) return;

  let code = commonJsToEsm(project.read(path));

  if (code === undefined) return;

  return { [target]: code };
}

/**
 * macro-decorators ships only CommonJS that sets `__esModule`.
 * In a package with `"type": "module"`, Vite gives its default import the whole `module.exports`, as Node does,
 * so `macro` is not a function after the ember-nvp stage.
 */
export const macroDecorators = inlineStage({
  name: "macro-decorators",
  label: "Move macro-decorators into the app as an ES module",
  files: {},
  generated: (project) =>
    convertedPackage(project, "macro-decorators", "dist/index.js", "app/utils/macro-decorators.js"),
  imports: { "macro-decorators": "app/utils/macro-decorators.js" },
  note: "macro-decorators is moved into the app, as an ES module.",
});
