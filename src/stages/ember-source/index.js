import { join } from "node:path";

import { parseProgram, walk } from "#ast.js";

import { addOverride, hasOverride } from "#manager-settings.js";
import {
  dependencyNames,
  editPackageJson,
  removeDependency,
  setDependency,
} from "#package-json.js";
import { published } from "#process.js";
import { Project } from "#project.js";
import { recordProgress } from "#progress.js";
import BLUEPRINTS from "./blueprints.json" with { type: "json" };
import { updateNodePins } from "#node-version.js";
import { dropPatches } from "#stages/patched-packages/index.js";
import { BABEL_CONFIGS, withoutCompilerPath } from "./compiler-path.js";
import { explicitRelationshipOptions } from "./ember-data.js";
import { KEYWORD_FILES, withoutKeywordImports } from "./helper-keywords.js";
import { TARGETS, withoutInternetExplorer } from "./targets.js";
import { FASTBOOT_CONFIG, withSandboxGlobals } from "#stages/addons/ember-fetch.js";
import { explicitInjections, routerServiceTransitions } from "./injections.js";
import { renameTitleHelpers } from "./page-title.js";
import {
  builtInAttributesInTemplates,
  keepArrayPrototypeExtensions,
  withoutPrototypeExtensions,
  moveHtmlSafe,
  queryParamsLists,
  rewriteWithHelpers,
  useServiceImports,
} from "./removed-apis.js";

/** @typedef {import('#types.js').Stage} Stage */

const EMBER_FROM = /\bfrom\s*["']ember["']/;

/**
 * A doc comment can show `import Ember from 'ember'`, as ember-ajax's request mixin does, so only the code counts.
 *
 * @param {string} source
 * @param {string} file
 * @returns {boolean} the code imports the `ember` module
 */
export function codeImportsEmber(source, file) {
  if (!EMBER_FROM.test(source)) return false;

  let program = parseProgram(source, file);

  if (!program) return true;

  let found = false;

  walk(program, (node) => {
    if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) &&
      node.source?.value === "ember" &&
      node.importKind !== "type" &&
      node.exportKind !== "type"
    ) {
      found = true;
    }
  });

  return found;
}

const AMD_BUNDLES = "https://deprecations.emberjs.com/id/using-amd-bundles";

/**
 * ember-source 7 has no AMD template compiler, so each v1 addon needs ember-cli-htmlbars 7,
 * which reads the ES module one. ember-cli-htmlbars 7 adds the async template compilation plugin,
 * which only ember-cli-babel 8 can run. classicEmberSupport() builds v1 addons with both.
 * ember-cli-babel 8 runs the plugin through broccoli-babel-transpiler, which calls Babel asynchronously from 8.1.
 * A lockfile can keep 8.0, because the range of ember-cli-babel accepts it.
 * The versions are the fallback when the registry does not answer.
 */
const EMBER_7_PINS = {
  "broccoli-babel-transpiler": "8.1.0",
  "ember-cli-babel": "8.3.2",
  "ember-cli-htmlbars": "7.0.1",
};

/**
 * @type {Record<string, Record<string, string>>}
 */
const TABLE = BLUEPRINTS;

const WEBPACK_EMBROIDER = new Set(["@embroider/compat", "@embroider/core"]);

/**
 * The LTS versions in order. `scripts/lts-blueprints.js` makes the table.
 */
const LTS = Object.keys(TABLE).sort((a, b) => compare(version(a), version(b)));

/**
 * Updates ember-source one LTS at a time, which is the path that Ember recommends for apps that update seldom.
 * Each step is one commit, and also updates the packages that the app blueprint of that version lists, if the app has them.
 *
 * ember-source 7 is not a classic ember-cli addon, so it builds only with Vite.
 * The steps up to 6.x run before the vite stage, and the 7.x steps later. See src/stages/index.js.
 *
 * @param {string} name
 * @param {(lts: string) => boolean} include
 * @returns {import('#types.js').StageGroup}
 */
function group(name, include) {
  return {
    name,
    label: "Update ember-source one LTS at a time",

    async expand(project) {
      let current = parse(project.dependency("ember-source"));

      if (!current) return [];

      return LTS.filter((lts) => include(lts) && compare(current, version(lts)) < 0).map(step);
    },
  };
}

export const classicLts = group("ember-source-classic", (lts) => version(lts)[0] < 7);
export const viteLts = group("ember-source-vite", (lts) => version(lts)[0] >= 7);

/**
 * @param {string} lts such as "4.12"
 * @returns {Stage}
 */
function step(lts) {
  let target = version(lts);

  return {
    name: `ember-source-${lts}`,
    label: `Update ember-source to ${lts}, and the packages that its app blueprint lists`,

    detect(project) {
      let current = parse(project.dependency("ember-source"));

      return current !== undefined && compare(current, target) < 0;
    },

    async check(project) {
      /**
       * Ember 7 has no `ember` module. The ember-globals stages move each use that has a module.
       */
      let ember =
        target[0] >= 7
          ? project.sourceFiles().filter((file) => codeImportsEmber(project.read(file), file))
          : [];

      return {
        blockers:
          ember.length > 0
            ? [
                {
                  title: "Code that imports the `ember` module, which Ember 7 does not have",
                  where: ember,
                  action:
                    "Import each API from its @ember/* module. ember-upgrade lists the private ones that have no module in its earlier findings.",
                },
              ]
            : [],
        todo: [],
      };
    },

    async run(project) {
      let emberDataBefore = parse(project.dependency("ember-data"));
      let pageTitle = parse(project.dependency("ember-page-title"));
      let glimmerComponent = parse(project.dependency("@glimmer/component"));
      let before = /** @type {[number, number, number]} */ (
        parse(project.dependency("ember-source"))
      );

      /** @type {string[]} */
      let updated = [];

      editPackageJson(project, (pkg) => {
        for (let [name, range] of Object.entries(TABLE[lts])) {
          let current = project.dependency(name);

          if (!current) continue;

          /**
           * @embroider/compat and @embroider/core 4 build only with Vite. An app on @embroider/webpack keeps
           * the versions that it has until the vite stage.
           */
          if (WEBPACK_EMBROIDER.has(name) && project.dependency("@embroider/webpack")) continue;

          let from = parse(current);
          let to = parse(range);

          /**
           * Only packages that the app has, and only up. A step never moves a package back.
           * A range with no version, such as `catalog:` or a git URL, stays as the app wrote it.
           */
          if (from && to && compare(from, to) < 0) {
            setDependency(pkg, name, range);
            updated.push(name);
          }
        }

        /**
         * The @ember-data packages release together with ember-data, at the same version.
         * An app that declares one of them gets a second copy of WarpDrive when only ember-data moves.
         */
        let emberData = TABLE[lts]["ember-data"];

        if (emberData && updated.includes("ember-data")) {
          for (let name of dependencyNames(project.packageJson)) {
            let from = parse(project.dependency(name));
            let to = parse(emberData);

            if (!name.startsWith("@ember-data/") || !from || !to || compare(from, to) >= 0)
              continue;

            setDependency(pkg, name, emberData);
            updated.push(name);
          }
        }

        /**
         * A Vite app compiles its own templates with babel-plugin-ember-template-compilation,
         * so only v1 addons need ember-cli-htmlbars.
         */
        if (target[0] >= 7) removeDependency(pkg, "ember-cli-htmlbars");
      });

      /**
       * Templates of ember-source 7.4 have `array` and `hash` as keywords.
       */
      if (target[0] > 7 || (target[0] === 7 && target[1] >= 4)) {
        for (let file of project.files(KEYWORD_FILES)) {
          let source = project.read(file);
          let output = withoutKeywordImports(source, file);

          if (output !== source) project.write(file, output);
        }
      }

      if (target[0] >= 7) {
        for (let file of BABEL_CONFIGS) {
          if (!project.has(file)) continue;

          let config = project.read(file);
          let output = withoutCompilerPath(config, file);

          if (output !== config) project.write(file, output);
        }
      }

      dropPatches(project, updated);

      /**
       * The @ember/test-helpers of the ember-source 6.4 blueprint calls appEmberSatisfies, which the macros
       * of v1 addons before @embroider/macros 1.19 do not know. The vite stage forces the same copy later.
       */
      if (
        (target[0] > 6 || (target[0] === 6 && target[1] >= 4)) &&
        !hasOverride(project, "@embroider/macros")
      ) {
        addOverride(
          project,
          "@embroider/macros",
          `^${published("@embroider/macros")?.version ?? "1.21.4"}`,
        );
        recordProgress(project, {
          id: "@embroider/macros",
          status: "override",
          note:
            "An override forces the latest @embroider/macros for all dependencies, because v1 addons depend on older versions, " +
            "which do not know the macros of @ember/test-helpers 5. Remove the override when no dependency needs an older version.",
        });
      }

      let newPageTitle = parse(project.dependency("ember-page-title"));
      let newGlimmerComponent = project.dependency("@glimmer/component");

      if (glimmerComponent?.[0] === 1 && parse(newGlimmerComponent)?.[0] === 2) {
        glimmerComponentOverride(project, /** @type {string} */ (newGlimmerComponent));
      }

      if (pageTitle && newPageTitle && pageTitle[0] < 6 && newPageTitle[0] >= 6) {
        renameTitleHelpers(project);
      }

      /** @type {import('#types.js').Finding[]} */
      let todo = [];
      let emberData = parse(project.dependency("ember-data"));

      /**
       * ember-data 4 depended on ember-inflector. ember-data 5 has it as an optional peer, and its deprecation support still imports it.
       */
      if (
        emberDataBefore?.[0] === 4 &&
        emberData?.[0] === 5 &&
        !project.dependency("ember-inflector")
      ) {
        editPackageJson(project, (pkg) =>
          setDependency(
            pkg,
            "ember-inflector",
            `^${published("ember-inflector", "6")?.version ?? "6.0.0"}`,
          ),
        );
      }

      if (emberData && emberData[0] >= 5) {
        let unreadable = explicitRelationshipOptions(project);

        if (unreadable.length > 0) {
          todo.push({
            title: "Relationships that need `async` and `inverse` options for ember-data 5",
            where: unreadable,
            action:
              "Add both options. `async: true` and the inverse field were the defaults before.",
          });
        }
      }

      /**
       * The ember-data of the newer blueprints calls structuredClone, which the FastBoot sandbox does not have.
       */
      if (project.has(FASTBOOT_CONFIG)) {
        let config = project.read(FASTBOOT_CONFIG);
        let output = withSandboxGlobals(config, ["structuredClone"]);

        if (output && output !== config) project.write(FASTBOOT_CONFIG, output);
      }

      if (before[0] < 5 && target[0] >= 5 && project.has(TARGETS)) {
        let targets = project.read(TARGETS);
        let output = withoutInternetExplorer(targets);

        if (output !== targets) project.write(TARGETS, output);
      }

      /**
       * The ember-cli of the ember-source 6 blueprints requires ES modules.
       */
      if (target[0] >= 6) updateNodePins(project);

      if (before[0] < 6 && target[0] >= 6) {
        keepArrayPrototypeExtensions(project);

        /**
         * After keepArrayPrototypeExtensions, which reads whether the app had the extensions.
         */
        for (let file of ["config/environment.js", "config/environment.cjs"]) {
          if (!project.has(file)) continue;

          let config = project.read(file);
          let output = withoutPrototypeExtensions(config, file);

          if (output !== config) project.write(file, output);
        }
      }
      if (before[0] < 5 && target[0] >= 5) {
        routerServiceTransitions(project);
        queryParamsLists(project);
      }

      if (before[0] < 4 && target[0] >= 4) {
        if (explicitInjections(project).length > 0) {
          todo.push({
            title: "Implicit injections are explicit `@service` declarations now",
            where: ["app/initializers", "app/instance-initializers"],
            action:
              "Check the templates of controllers that have no class. They read the injected service, and need a controller that declares it.",
          });
        }

        rewriteWithHelpers(project);
        moveHtmlSafe(project);
        builtInAttributesInTemplates(project);
      }

      if (target[0] >= 7) {
        useServiceImports(project);
        updateEmberImporters(project);

        for (let [name, fallback] of Object.entries(EMBER_7_PINS)) {
          addOverride(project, name, `^${published(name)?.version ?? fallback}`);
          recordProgress(project, {
            id: name,
            status: "override",
            note:
              `An override forces the latest ${name} for all dependencies, because v1 addons depend on older versions. ` +
              "Remove the override when vite.config no longer uses classicEmberSupport().",
            links: [AMD_BUNDLES],
          });
        }
      }

      return todo;
    },
  };
}

/**
 * @glimmer/component 1 is a v1 addon, so the app tree of each copy merges into the app.
 * Its `component-managers/glimmer.js` imports `@glimmer/component/-private/ember-component-manager`,
 * which resolves from the app to version 2, and version 2 does not export it.
 * The override gives the addons that depend on version 1 the app's version.
 *
 * @param {import('#project.js').Project} project
 * @param {string} range
 */
function glimmerComponentOverride(project, range) {
  addOverride(project, "@glimmer/component", range);
  recordProgress(project, {
    id: "@glimmer/component",
    status: "override",
    note:
      `An override forces @glimmer/component ${range} for all dependencies, because the app tree of version 1 imports a module that version 2 does not export. ` +
      "Remove the override when no dependency needs @glimmer/component 1.",
    links: ["https://www.npmjs.com/package/@glimmer/component"],
  });
}

/**
 * ember-source 7 has no `ember` module. The app's own imports are for the ember-globals stage,
 * so this is for the dependencies: each one whose installed code imports `ember` goes to its latest version,
 * and so does an override that holds it back.
 *
 * @param {import('#project.js').Project} project
 */
function updateEmberImporters(project) {
  let pkg = JSON.parse(project.read("package.json"));

  for (let name of dependencyNames(pkg)) {
    if (name === "ember-source" || !importsEmber(join(project.directory, "node_modules", name))) {
      continue;
    }

    let latest = published(name)?.version;

    if (!latest || parse(latest)?.[0] === parse(project.dependency(name))?.[0]) continue;

    editPackageJson(project, (manifest) => setDependency(manifest, name, `^${latest}`));

    if (hasOverride(project, name)) addOverride(project, name, `^${latest}`);
  }
}

/**
 * @param {string} directory an installed package
 * @returns {boolean} its code imports the `ember` module
 */
function importsEmber(directory) {
  let dependency = new Project(directory);

  if (!dependency.has("package.json")) return false;

  return dependency
    .files(["**/*.{js,mjs,cjs}"])
    .filter((file) => !/(^|\/)tests?\//.test(file))
    .some((file) =>
      /\bfrom\s*['"]ember['"]|\brequire\(\s*['"]ember['"]\s*\)/.test(dependency.read(file)),
    );
}

/**
 * @param {string | undefined} range such as "~3.28.8", "^5.4.1", or "4.12"
 * @returns {[number, number, number] | undefined} the lowest version that the range allows
 */
export function parse(range) {
  let match = range?.match(/(\d+)\.(\d+)(?:\.(\d+))?/);

  if (!match) return;

  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/**
 * @param {string} lts a key of the table, which always has a version
 * @returns {[number, number, number]}
 */
function version(lts) {
  return /** @type {[number, number, number]} */ (parse(lts));
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 */
function compare(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
