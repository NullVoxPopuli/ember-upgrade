import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { dependencyNames } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const EXTENSIONS = [".js", ".ts", ".gjs", ".gts", ".hbs"];

/**
 * The modules that an addon recommends in place of its app-js entry, which it deprecates.
 * ember-data deprecated the store service and the transforms that it installs this way (ember-data:deprecate-legacy-imports).
 *
 * @type {Record<string, Record<string, string>>}
 */
const RECOMMENDED = {
  "ember-data": {
    "./services/store.js": `export { default } from "ember-data/store";\n`,
    "./transforms/boolean.js": `export { BooleanTransform as default } from "@ember-data/serializer/transform";\n`,
    "./transforms/date.js": `export { DateTransform as default } from "@ember-data/serializer/transform";\n`,
    "./transforms/number.js": `export { NumberTransform as default } from "@ember-data/serializer/transform";\n`,
    "./transforms/string.js": `export { StringTransform as default } from "@ember-data/serializer/transform";\n`,
  },
};

/**
 * The app-js entries that only a template finds by name.
 * Services, initializers, transforms and the other entries are resolver lookups that stay.
 */
const BY_NAME = /^\.\/(components|helpers|modifiers|templates\/components)\//;

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
 * The text of each template in JavaScript: a tagged `hbs` string, or the string of a `precompileTemplate` call.
 */
const TEMPLATE_IN_JS =
  /(?<![.\w])hbs`((?:[^`\\]|\\.)*)`|precompileTemplate\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)(\s*,\s*\{[^)]*?strictMode\s*:\s*true)?/g;

/**
 * @param {string} source
 * @returns {string[]} the loose-mode templates of the JavaScript
 */
function looseTemplatesIn(source) {
  /**
   * Doc comments show templates as examples.
   */
  let code = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");

  /**
   * A template that the build compiled holds its names in its wire format.
   */
  if (/["']?isStrictMode["']?\s*:\s*false/.test(code)) return [code];

  /** @type {string[]} */
  let templates = [];

  for (let match of code.matchAll(TEMPLATE_IN_JS)) {
    if (match[1] !== undefined) templates.push(match[1]);
    else if (!match[3]) templates.push(match[2]);
  }

  return templates;
}

/**
 * @param {string} directory
 * @param {(path: string) => string[]} read
 * @returns {string[]}
 */
function templatesUnder(directory, read) {
  if (!existsSync(directory)) return [];

  /** @type {string[]} */
  let templates = [];

  for (let entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;

    let path = join(entry.parentPath, entry.name);

    if (path.slice(directory.length).includes("node_modules")) continue;

    templates = templates.concat(read(path));
  }

  return templates;
}

/**
 * Only the files that the app builds count, not blueprints or docs.
 * A v1 addon's templates are loose mode. A v2 addon's are in its `dist`.
 * ember-source's own templates use only the built-in components and helpers.
 *
 * @param {Addon} addon
 * @returns {string[]}
 */
function addonLooseTemplates(addon) {
  if (addon.name === "ember-source") return [];

  if (addon.manifest["ember-addon"]?.version !== 2) {
    return ["addon", "app"].flatMap((folder) =>
      templatesUnder(join(addon.directory, folder), (path) =>
        path.endsWith(".hbs") ? [readFileSync(path, "utf8")] : [],
      ),
    );
  }

  return templatesUnder(join(addon.directory, "dist"), (path) =>
    /\.m?js$/.test(path) ? looseTemplatesIn(readFileSync(path, "utf8")) : [],
  );
}

/**
 * A loose-mode template, of the app or of an addon, finds components, helpers and modifiers by name
 * through the app's modules. A strict-mode template imports them.
 *
 * @param {Project} project
 * @param {Addon[]} addons
 * @returns {string[]}
 */
export function looseTemplates(project, addons) {
  let templates = project
    .files(["{app,tests,lib}/**/*.{hbs,js,ts}"])
    .flatMap((file) =>
      file.endsWith(".hbs") ? [project.read(file)] : looseTemplatesIn(project.read(file)),
    );

  return templates.concat(addons.flatMap((addon) => addonLooseTemplates(addon)));
}

/**
 * @param {string} appPath an app-js entry, such as `./components/power-select/trigger.js`
 * @param {string[]} templates
 * @returns {boolean} a template can call the module by its name
 */
export function calledByName(appPath, templates) {
  let name = appPath.replace(BY_NAME, "").replace(/\.\w+$/, "");
  let pascal = name
    .split("/")
    .map((part) => part.replace(/(?:^|-)(\w)/g, (_, letter) => letter.toUpperCase()))
    .join("::");
  let pattern = new RegExp(
    `(?<![\\w.@-])(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${pascal})(?![\\w-])`,
  );

  return templates.some((template) => pattern.test(template));
}

/**
 * The files of the addons' app trees that the app does not have.
 * A component, helper or modifier is left out when no loose-mode template calls it by name.
 *
 * @param {Project} project
 * @returns {AppFile[]}
 */
export function missingAppFiles(project) {
  /** @type {AppFile[]} */
  let files = [];
  let taken = new Set();
  let addons = addonsOf(project);
  let templates = looseTemplates(project, addons);

  for (let addon of addons) {
    let appJs = addon.manifest["ember-addon"]?.["app-js"] ?? {};

    for (let [appPath, target] of Object.entries(appJs)) {
      if (BY_NAME.test(appPath) && !calledByName(appPath, templates)) continue;

      let file = join("app", appPath).split("\\").join("/");
      let base = file.replace(/\.\w+$/, "");

      if (taken.has(base) || EXTENSIONS.some((extension) => project.has(base + extension)))
        continue;

      taken.add(base);

      let specifier = exportedAs(addon.name, addon.manifest, String(target));
      let reexport = specifier
        ? `export * from "${specifier}";\nexport { default } from "${specifier}";\n`
        : readFileSync(join(addon.directory, String(target)), "utf8");
      let contents = RECOMMENDED[addon.name]?.[appPath] ?? reexport;

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
 * Strict-mode templates import what they use, so a component, helper or modifier
 * is written only when a loose-mode template calls it by name.
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
