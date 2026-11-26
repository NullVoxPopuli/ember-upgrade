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
 * Removes each `{{x/y}}` and `{{#x-y}}...{{/x-y}}` whose name is no component or helper.
 * Such a call threw each time that it rendered, and Embroider stops the build on it.
 *
 * @param {string} template the source of an .hbs file
 * @param {{ components: Set<string>, helpers: Set<string> }} names the names that a template can call
 * @returns {{ output: string, removed: string[] }}
 */
export function removeMissingCalls(template, names) {
  let source = `${OPEN}${template}</template>`;
  let tree = toTree(source, { filePath: "template.gjs" });
  /** @type {Set<string>} */
  let locals = new Set();
  /** @type {Node[]} */
  let calls = [];

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
    if (calls.some((call) => call.start <= node.start && node.end <= call.end)) return;

    calls.push(node);
  });

  if (calls.length === 0) return { output: template, removed: [] };

  let edits = new Edits(source);

  for (let call of calls) edits.removeLine(call);

  let output = edits.apply();

  return {
    output: output.slice(OPEN.length, output.length - "</template>".length),
    removed: calls.map((call) => call.path.original),
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
