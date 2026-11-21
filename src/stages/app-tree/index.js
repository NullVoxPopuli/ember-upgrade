import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { dependencyNames } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const EXTENSIONS = [".js", ".ts", ".gjs", ".gts", ".hbs"];

/**
 * @typedef {object} Addon
 * @property {string} name
 * @property {string} directory where it is installed
 * @property {Record<string, any>} manifest
 */

/**
 * @typedef {object} AppFile
 * @property {string} addon
 * @property {string} file the file to write, relative to the project
 * @property {string} contents
 */

/**
 * @param {string} from a package's directory
 * @param {string} name
 * @returns {string | undefined} where `name` is installed, as Node would find it from `from`
 */
function packageDirectory(from, name) {
  for (let directory = from; ; directory = dirname(directory)) {
    let candidate = join(directory, "node_modules", name);

    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(directory) === directory) return;
  }
}

/**
 * The v2 addons of the app, and the addons of those addons, as ember-cli found them.
 * The first copy of a name wins, so the app's own dependency comes before a nested one.
 *
 * @param {Project} project
 * @returns {Addon[]}
 */
export function addonsOf(project) {
  /** @type {Addon[]} */
  let found = [];
  let seen = new Set();
  let queue = dependencyNames(project.packageJson).map((name) => ({
    name,
    from: project.directory,
  }));

  for (let item = queue.shift(); item; item = queue.shift()) {
    if (seen.has(item.name)) continue;

    let directory = packageDirectory(item.from, item.name);

    if (!directory) continue;

    let manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));

    if (!manifest.keywords?.includes("ember-addon")) continue;

    seen.add(item.name);
    found.push({ name: item.name, directory, manifest });

    for (let name of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ name, from: directory });
    }
  }

  return found;
}

/**
 * @param {string} name
 * @param {Record<string, any>} manifest
 * @param {string} target a file of the package, such as `./dist/_app_/services/x.js`
 * @returns {string | undefined} the specifier that reaches `target` through the package's `exports`
 */
export function exportedAs(name, manifest, target) {
  let exports = manifest.exports;

  if (!exports) return `${name}/${target.replace(/^\.\//, "").replace(/\.js$/, "")}`;
  if (typeof exports !== "object") return;

  for (let [key, value] of Object.entries(exports)) {
    let path = typeof value === "string" ? value : (value?.import ?? value?.default);

    if (typeof path !== "string") continue;

    if (!path.includes("*")) {
      if (path === target) return `${name}/${key.replace(/^\.\//, "")}`;
      continue;
    }

    let [before = "", after = ""] = path.split("*");

    if (
      target.startsWith(before) &&
      target.endsWith(after) &&
      target.length >= before.length + after.length
    ) {
      return `${name}/${key.replace(/^\.\//, "").replace("*", target.slice(before.length, target.length - after.length))}`;
    }
  }
}

/**
 * The files of the addons' app trees that the app does not have.
 *
 * @param {Project} project
 * @returns {AppFile[]}
 */
export function missingAppFiles(project) {
  /** @type {AppFile[]} */
  let files = [];
  let taken = new Set();

  for (let addon of addonsOf(project)) {
    let appJs = addon.manifest["ember-addon"]?.["app-js"] ?? {};

    for (let [appPath, target] of Object.entries(appJs)) {
      let file = join("app", appPath).split("\\").join("/");
      let base = file.replace(/\.\w+$/, "");

      if (taken.has(base) || EXTENSIONS.some((extension) => project.has(base + extension)))
        continue;

      taken.add(base);

      let specifier = exportedAs(addon.name, addon.manifest, String(target));
      let contents = specifier
        ? `export * from "${specifier}";\nexport { default } from "${specifier}";\n`
        : readFileSync(join(addon.directory, String(target)), "utf8");

      files.push({ addon: addon.name, file, contents });
    }
  }

  return files;
}

/**
 * ember-cli merged each addon's app tree (`ember-addon.app-js`) into the app, so the resolver found
 * the addon's services, initializers, transforms, and the components that its own templates use by name.
 * ember.nvp apps do not merge app trees, so the stage writes those modules into app/,
 * as re-exports of the addon. The app's own files win, as they did in ember-cli.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "app-tree",
  label: "Write the modules that addons merged into the app (ember-addon.app-js) into app/",

  detect(project) {
    return missingAppFiles(project).length > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let files = missingAppFiles(project);
    /** @type {Map<string, string[]>} */
    let byAddon = new Map();

    for (let { addon, file, contents } of files) {
      mkdirSync(join(project.directory, dirname(file)), { recursive: true });
      project.write(file, contents);
      byAddon.set(addon, (byAddon.get(addon) ?? []).concat(file));
    }

    for (let [addon, written] of byAddon) {
      recordProgress(project, {
        id: `app-tree: ${addon}`,
        status: "added",
        note:
          `${addon} merged these modules into the app through ember-cli: ${written.join(", ")}. ` +
          "ember.nvp apps do not merge app trees, so they re-export the addon now. Delete the ones that the app does not use.",
      });
    }

    return [];
  },
};
