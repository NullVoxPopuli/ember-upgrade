import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import BLUEPRINTS from "./blueprints.json" with { type: "json" };

/** @typedef {import('#types.js').Stage} Stage */

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
         * ember-cli-htmlbars reads the template compiler from the classic ember-source addon, which 7.x does not have.
         * A Vite app compiles templates with babel-plugin-ember-template-compilation, so it does not need it.
         */
        if (target[0] >= 7) removeDependency(pkg, "ember-cli-htmlbars");
      });

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
