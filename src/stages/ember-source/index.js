import { addOverride } from "#manager-settings.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";
import BLUEPRINTS from "./blueprints.json" with { type: "json" };

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

      if (target[0] >= 7) {
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
