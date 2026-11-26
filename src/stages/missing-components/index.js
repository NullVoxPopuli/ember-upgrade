import { toTree } from "ember-estree";

import { Edits } from "#edits.js";
import { recordProgress } from "#progress.js";
import { templateNames } from "#stages/dynamic-components/names.js";

/** @typedef {import('#ast.js').Node} Node */

const TEMPLATES = ["app/**/*.hbs"];
const OPEN = "<template>";

/**
 * The keywords whose names look like component names.
 */
const KEYWORDS = new Set([
  "-get-dynamic-var",
  "-in-element",
  "-with-dynamic-vars",
  "each-in",
  "has-block",
  "has-block-params",
  "in-element",
  "link-to",
  "query-params",
  "unique-id",
]);

/**
 * @param {unknown} node
 * @param {(node: Node) => void} visit
 */
function walkAll(node, visit) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let child of node) walkAll(child, visit);
    return;
  }

  let astNode = /** @type {Node} */ (node);

  if (typeof astNode.type === "string") visit(astNode);

  for (let key in astNode) {
    if (key === "loc" || key === "range" || key === "parent" || key === "tokens") continue;

    walkAll(astNode[key], visit);
  }
}

/**
 * A name of an addon, such as `vertical-collection` or `ember-power-select-is-selected`, is the addon's API.
 * A new version of the addon can have it under another name or as an import, so a person moves the call.
 *
 * @param {string} name
 * @param {string[]} addons
 */
function fromAddon(name, addons) {
  return addons.some(
    (addon) => name === addon || name.startsWith(`${addon}-`) || name.startsWith(`${addon}/`),
  );
}

/**
 * @param {string} template the source of an .hbs file
 * @param {{ components: Set<string>, helpers: Set<string>, addons: string[] }} names the names that a template can call, and the addons
 * @returns {{ source: string, missing: Node[], fromAddons: string[] }} the `{{x-y}}` calls whose name is no component or helper,
 * apart from the names of addons, and those names
 */
function unknownCalls(template, names) {
  let source = `${OPEN}${template}</template>`;
  let tree = toTree(source, { filePath: "template.gjs" });
  /** @type {Set<string>} */
  let locals = new Set();
  /** @type {Node[]} */
  let missing = [];
  /** @type {Set<string>} */
  let fromAddons = new Set();

  walkAll(tree, (node) => {
    for (let param of node.blockParams ?? []) locals.add(param);
  });

  walkAll(tree, (node) => {
    if (node.type !== "GlimmerMustacheStatement" && node.type !== "GlimmerBlockStatement") return;
    if (node.path?.type !== "GlimmerPathExpression") return;

    let name = node.path.original;

    if (!/[-/]/.test(name) || name.includes(".") || name.startsWith("@")) return;
    if (KEYWORDS.has(name) || locals.has(name)) return;
    if (names.components.has(name) || names.helpers.has(name)) return;
    if (fromAddon(name, names.addons)) {
      fromAddons.add(name);
      return;
    }
    if (missing.some((call) => call.start <= node.start && node.end <= call.end)) return;

    missing.push(node);
  });

  return { source, missing, fromAddons: Array.from(fromAddons).sort() };
}

/**
 * @param {string} template the source of an .hbs file
 * @param {{ components: Set<string>, helpers: Set<string>, addons: string[] }} names
 * @returns {string[]} the names that the template calls, which no component or helper has, and which an addon's name starts
 */
export function addonCalls(template, names) {
  return unknownCalls(template, names).fromAddons;
}

/**
 * Removes each `{{x/y}}` and `{{#x-y}}...{{/x-y}}` whose name is no component or helper.
 * Such a call threw each time that it rendered, and Embroider stops the build on it.
 *
 * @param {string} template the source of an .hbs file
 * @param {{ components: Set<string>, helpers: Set<string>, addons: string[] }} names the names that a template can call, and the addons
 * @returns {{ output: string, removed: string[] }}
 */
export function removeMissingCalls(template, names) {
  let { source, missing } = unknownCalls(template, names);

  if (missing.length === 0) return { output: template, removed: [] };

  let edits = new Edits(source);

  for (let call of missing) edits.removeLine(call);

  let output = edits.apply();

  return {
    output: output.slice(OPEN.length, output.length - "</template>".length),
    removed: missing.map((call) => call.path.original),
  };
}

/**
 * A template can call a component that the app removed, or that only another edition of the app had.
 * The call threw when it rendered, so the app did not render it.
 * The template-tag codemod and Embroider stop on it, so this stage removes it.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "missing-components",
  label: "Remove the template calls to components and helpers that do not exist",
  needsInstall: true,

  detect(project) {
    let names = templateNames(project);

    if (!names) return false;

    return project
      .files(TEMPLATES)
      .some((file) => removeMissingCalls(project.read(file), names).removed.length > 0);
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let names = templateNames(project);
    /** @type {string[]} */
    let removed = [];

    if (!names) return [];

    for (let file of project.files(TEMPLATES)) {
      let result = removeMissingCalls(project.read(file), names);

      if (result.removed.length === 0) continue;

      project.write(file, result.output);

      for (let name of result.removed) removed.push(`${file} (${name})`);
    }

    recordProgress(project, {
      id: "missing-components",
      status: "todo",
      note:
        `These templates called components or helpers that neither the app nor its addons have, so the calls were removed: ${removed.join(", ")}. ` +
        "Check that the app did not need them.",
    });

    return [];
  },
};
