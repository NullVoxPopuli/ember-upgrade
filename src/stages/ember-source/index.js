import { join } from "node:path";

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
import { renameTitleHelpers } from "./page-title.js";
import { moveHtmlSafe, rewriteWithHelpers, useServiceImports } from "./removed-apis.js";

/** @typedef {import('#types.js').Stage} Stage */

const AMD_BUNDLES = "https://deprecations.emberjs.com/id/using-amd-bundles";

/**
 * ember-source 7 has no AMD template compiler, so each v1 addon needs ember-cli-htmlbars 7,
 * which reads the ES module one. ember-cli-htmlbars 7 adds the async template compilation plugin,
 * which only ember-cli-babel 8 can run. classicEmberSupport() builds v1 addons with both.
 * The versions are the fallback when the registry does not answer.
 */
const EMBER_7_PINS = {
  "ember-cli-babel": "8.3.2",
  "ember-cli-htmlbars": "7.0.1",
};

/**
 * @type {Record<string, Record<string, string>>}
 */
const TABLE = BLUEPRINTS;

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

    async check() {
      return { blockers: [], todo: [] };
    },

    async run(project) {
      let pageTitle = parse(project.dependency("ember-page-title"));
      let before = /** @type {[number, number, number]} */ (
        parse(project.dependency("ember-source"))
      );

      editPackageJson(project, (pkg) => {
        for (let [name, range] of Object.entries(TABLE[lts])) {
          let current = project.dependency(name);

          if (!current) continue;

          let from = parse(current);
          let to = parse(range);

          /**
           * Only packages that the app has, and only up. A step never moves a package back.
           * A range with no version, such as `catalog:` or a git URL, stays as the app wrote it.
           */
          if (from && to && compare(from, to) < 0) setDependency(pkg, name, range);
        }

        /**
         * A Vite app compiles its own templates with babel-plugin-ember-template-compilation,
         * so only v1 addons need ember-cli-htmlbars.
         */
        if (target[0] >= 7) removeDependency(pkg, "ember-cli-htmlbars");
      });

      let newPageTitle = parse(project.dependency("ember-page-title"));

      if (pageTitle && newPageTitle && pageTitle[0] < 6 && newPageTitle[0] >= 6) {
        renameTitleHelpers(project);
      }

      if (before[0] < 4 && target[0] >= 4) {
        rewriteWithHelpers(project);
        moveHtmlSafe(project);
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

      return [];
    },
  };
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
