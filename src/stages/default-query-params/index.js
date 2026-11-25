import { parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('#project.js').Project} Project */

const CONTROLLERS = ["app/controllers/**/*.{js,ts}"];
const TESTS = ["tests/**/*.{js,ts,gjs,gts}"];

/**
 * @param {Project} project
 * @returns {Map<string, string>} each query param of the controllers, with its default value as the URL writes it
 */
export function queryParamDefaults(project) {
  /** @type {Map<string, Set<string>>} */
  let values = new Map();

  for (let file of project.files(CONTROLLERS)) {
    let program = parseProgram(project.read(file), file);

    walk(program, (node) => {
      if (node.type !== "ClassBody") return;

      let fields = new Map();
      /** @type {string[]} */
      let names = [];

      for (let member of node.body) {
        if (member.type !== "PropertyDefinition" || member.computed || member.static) continue;

        let key = member.key.name ?? member.key.value;

        if (key === "queryParams" && member.value?.type === "ArrayExpression") {
          for (let element of member.value.elements) {
            if (element?.type === "Literal" && typeof element.value === "string")
              names.push(element.value);
          }
        } else if (member.value?.type === "Literal" && member.value.value !== null) {
          fields.set(key, String(member.value.value));
        }
      }

      for (let name of names) {
        if (!fields.has(name)) continue;

        let set = values.get(name) ?? new Set();

        set.add(fields.get(name));
        values.set(name, set);
      }
    });
  }

  /** @type {Map<string, string>} */
  let defaults = new Map();

  /**
   * Two controllers with one name and two defaults do not tell which one a URL is for.
   */
  for (let [name, set] of values) {
    if (set.size === 1) defaults.set(name, Array.from(set)[0]);
  }

  return defaults;
}

/**
 * @param {string} url
 * @param {Map<string, string>} defaults
 * @returns {string}
 */
export function withoutDefaults(url, defaults) {
  let at = url.indexOf("?");

  if (at === -1) return url;

  let hash = url.indexOf("#", at);
  let end = hash === -1 ? url.length : hash;
  let pairs = url
    .slice(at + 1, end)
    .split("&")
    .filter((pair) => {
      let [name, value = ""] = pair.split("=");

      return defaults.get(name) !== value;
    });

  return url.slice(0, at) + (pairs.length > 0 ? `?${pairs.join("&")}` : "") + url.slice(end);
}

/**
 * Removes the default query params from the URLs that tests compare with `currentURL()`.
 *
 * @param {string} source
 * @param {string} file
 * @param {Map<string, string>} defaults from `queryParamDefaults`
 * @returns {string | undefined}
 */
export function withDefaultQueryParams(source, file, defaults) {
  if (defaults.size === 0 || !source.includes("currentURL")) return;

  let program = parseProgram(source, file);

  if (!program) return;

  let edits = new Edits(source);

  walk(program, (node) => {
    if (node.type !== "CallExpression") return;

    let comparesUrl = node.arguments.some(
      (/** @type {Node} */ arg) =>
        arg.type === "CallExpression" &&
        arg.callee.type === "Identifier" &&
        arg.callee.name === "currentURL",
    );

    if (!comparesUrl) return;

    for (let arg of node.arguments) {
      if (arg.type !== "Literal" || typeof arg.value !== "string" || !arg.value.startsWith("/"))
        continue;

      let url = withoutDefaults(arg.value, defaults);

      if (url === arg.value) continue;

      let quote = source[arg.start];

      edits.replace(arg, `${quote}${url}${quote}`);
    }
  });

  return edits.size > 0 ? edits.apply() : undefined;
}

/**
 * @param {Project} project
 * @returns {Map<string, string>} the changed tests
 */
function plan(project) {
  let defaults = queryParamDefaults(project);
  /** @type {Map<string, string>} */
  let changes = new Map();

  for (let file of project.files(TESTS)) {
    let output = withDefaultQueryParams(project.read(file), file, defaults);

    if (output) changes.set(file, output);
  }

  return changes;
}

/**
 * Ember 7 leaves a query param out of the URL when it has the controller's default value.
 * Ember 3's router service wrote it, and the tests of older apps expect it.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "default-query-params",
  label: "Remove the default query params from the URLs that tests expect",

  detect(project) {
    return plan(project).size > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    for (let [file, output] of plan(project)) project.write(file, output);

    return [];
  },
};
