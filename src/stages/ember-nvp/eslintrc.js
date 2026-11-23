import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The legacy config files, in the order that ESLint 8 reads them.
 * A `.eslintrc` can be YAML, which is not read here.
 */
export const ESLINTRC_FILES = [".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc"];

/**
 * The parts of a legacy config that carry over. The other parts, such as `parser`, do not.
 *
 * @typedef {object} Override
 * @property {string | string[]} [files]
 * @property {string | string[]} [excludedFiles]
 * @property {Record<string, unknown>} [globals]
 * @property {Record<string, unknown>} [rules]
 */

/**
 * @typedef {object} Eslintrc
 * @property {Record<string, unknown>} [globals]
 * @property {Record<string, unknown>} [rules]
 * @property {Override[]} [overrides]
 */

/**
 * @param {import('#project.js').Project} project
 * @returns {Eslintrc | undefined}
 */
export function readEslintrc(project) {
  let file = ESLINTRC_FILES.find((name) => project.has(name));

  if (!file) return;

  try {
    if (file.endsWith("js")) {
      return createRequire(join(project.directory, "package.json"))(join(project.directory, file));
    }

    return JSON.parse(project.read(file));
  } catch {
    return;
  }
}

/**
 * eslint-plugin-n replaced eslint-plugin-node, with the same rule names.
 *
 * @param {string} rule
 * @returns {string}
 */
function renamed(rule) {
  return rule.startsWith("node/") ? `n/${rule.slice("node/".length)}` : rule;
}

/**
 * @param {unknown} setting
 * @returns {boolean}
 */
function isOff(setting) {
  let severity = Array.isArray(setting) ? setting[0] : setting;

  return severity === "off" || severity === 0;
}

/**
 * @param {string | string[] | undefined} globs
 * @returns {string[] | undefined}
 */
function list(globs) {
  if (globs === undefined) return;

  return Array.isArray(globs) ? globs : [globs];
}

/**
 * A pair of globs in `files` matches a file that matches both.
 *
 * @param {string[] | undefined} files
 * @param {string[] | undefined} scope
 * @returns {(string | string[])[] | undefined}
 */
function within(files, scope) {
  if (!scope) return files;
  if (!files) return scope;

  /** @type {string[][]} */
  let pairs = [];

  for (let file of files) {
    for (let glob of scope) pairs.push([file, glob]);
  }

  return pairs;
}

/**
 * The rules that the new config has, and the files where each plugin is defined.
 *
 * @typedef {object} FlatRules
 * @property {(rule: string) => boolean} known
 * @property {(plugin: string) => string[] | undefined} scope undefined when the plugin is defined for each file
 */

/**
 * The globals and rule settings of a legacy config, as flat config objects.
 * The new config sets the parser, the environments and the plugins,
 * so only the settings of the app itself carry over.
 * A rule that the new config does not know, such as one of eslint-plugin-prettier, does not.
 *
 * ESLint stops at an enabled rule for a file where the rule's plugin is not defined,
 * so each enabled plugin rule gets the files of its plugin.
 *
 * @param {Eslintrc} eslintrc
 * @param {FlatRules} rules
 * @returns {Record<string, unknown>[]}
 */
export function flatSettings(eslintrc, { known, scope }) {
  /** @type {Record<string, unknown>[]} */
  let entries = [];
  /** @type {Override[]} */
  let overrides = [{ globals: eslintrc.globals, rules: eslintrc.rules }];

  overrides = overrides.concat(eslintrc.overrides ?? []);

  for (let override of overrides) {
    let files = list(override.files);
    let ignores = list(override.excludedFiles);
    /**
     * By plugin. The empty key is for the rules of ESLint, and the rules that are off.
     *
     * @type {Map<string, Record<string, unknown>>}
     */
    let groups = new Map([["", {}]]);

    for (let [rule, setting] of Object.entries(override.rules ?? {})) {
      let name = renamed(rule);
      let slash = name.lastIndexOf("/");

      if (!known(name)) continue;

      let plugin = slash === -1 || isOff(setting) ? "" : name.slice(0, slash);
      let group = groups.get(plugin) ?? {};

      group[name] = setting;
      groups.set(plugin, group);
    }

    for (let [plugin, group] of groups) {
      /** @type {Record<string, unknown>} */
      let entry = {};
      let scoped = plugin === "" ? files : within(files, scope(plugin));

      if (scoped) entry.files = scoped;
      if (ignores) entry.ignores = ignores;
      if (plugin === "" && override.globals && Object.keys(override.globals).length > 0) {
        entry.languageOptions = { globals: override.globals };
      }
      if (Object.keys(group).length > 0) entry.rules = group;

      if (entry.languageOptions || entry.rules) entries.push(entry);
    }
  }

  return entries;
}

/**
 * Adds the entries at the end of the array that the flat config exports.
 *
 * @param {string} source eslint.config.js
 * @param {Record<string, unknown>[]} entries
 * @returns {string | undefined} undefined when the array is not found
 */
export function withFlatSettings(source, entries) {
  let end = source.lastIndexOf("];");

  if (end === -1 || entries.length === 0) return;

  let text = entries
    .map((entry) => {
      let object = JSON.stringify(entry, null, 2).replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, "$1$2:");

      return `  ${object.replaceAll("\n", "\n  ")},\n`;
    })
    .join("");

  return source.slice(0, end) + text + source.slice(end);
}

/**
 * Reads the rules that the project's flat config can use: the rules of ESLint,
 * and the rules of each plugin in the config.
 *
 * @param {import('#project.js').Project} project
 * @param {string} config the flat config file
 * @returns {Promise<FlatRules>}
 */
export async function flatRulesOf(project, config) {
  let require = createRequire(join(project.directory, "package.json"));
  let eslint = await import(pathToFileURL(require.resolve("eslint/use-at-your-own-risk")).href);
  /** @type {Map<string, unknown>} */
  let builtin = eslint.builtinRules ?? eslint.default?.builtinRules;
  /** @type {{ files?: string[], plugins?: Record<string, { rules?: Record<string, unknown> }> }[]} */
  let entries = (await import(pathToFileURL(join(project.directory, config)).href)).default;
  /** @type {Record<string, Record<string, unknown>>} */
  let plugins = {};
  /** @type {Record<string, string[] | undefined>} */
  let scopes = {};

  for (let entry of entries) {
    for (let [prefix, plugin] of Object.entries(entry.plugins ?? {})) {
      plugins[prefix] = plugin.rules ?? {};

      let unscoped = prefix in scopes && scopes[prefix] === undefined;

      scopes[prefix] =
        !entry.files || unscoped ? undefined : (scopes[prefix] ?? []).concat(entry.files);
    }
  }

  return {
    known(rule) {
      let slash = rule.lastIndexOf("/");

      if (slash === -1) return builtin.has(rule);

      return rule.slice(slash + 1) in (plugins[rule.slice(0, slash)] ?? {});
    },
    scope: (plugin) => scopes[plugin],
  };
}
