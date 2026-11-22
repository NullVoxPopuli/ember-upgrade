import { toTree } from "ember-estree";

import { Edits } from "#edits.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#ast.js').Node} Node */

const TEMPLATES = ["app/**/*.hbs"];
const OPEN = "<template>";
const OPENING = /^\{\{~?#component[\s\S]*?~?\}\}/;
const CLOSING = /\{\{~?\/component~?\}\}$/;

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
 * @param {string} source
 * @param {Node} pair a named argument of the `component` call
 * @returns {string} the same argument of an angle bracket invocation
 */
function argument(source, pair) {
  let text = source.slice(pair.value.start, pair.value.end);

  switch (pair.value.type) {
    case "GlimmerStringLiteral":
      return `@${pair.key}=${text}`;
    case "GlimmerSubExpression":
      return `@${pair.key}={{${text.slice(1, -1)}}}`;
    default:
      return `@${pair.key}={{${text}}}`;
  }
}

/**
 * @param {Node} node a `component` mustache or block
 * @returns {boolean} the first argument is a value, which an angle bracket invocation can take
 */
function convertible(node) {
  return (
    node.path?.original === "component" &&
    node.params?.length === 1 &&
    node.params[0].type === "GlimmerPathExpression" &&
    !node.inverse
  );
}

/**
 * Turns `{{component <value> a=b}}` into `<value @a={{b}} />`, and the block form into an element.
 *
 * @param {string} template the source of an .hbs file
 * @returns {string} the new source, the same when the template has no such call
 */
export function angleBracketComponents(template) {
  let source = `${OPEN}${template}</template>`;
  /** @type {Node[]} */
  let calls = [];

  walkAll(toTree(source, { filePath: "template.gjs" }), (node) => {
    if (
      (node.type === "GlimmerMustacheStatement" || node.type === "GlimmerBlockStatement") &&
      convertible(node)
    ) {
      calls.push(node);
    }
  });

  if (calls.length === 0) return template;

  let edits = new Edits(source);

  for (let call of calls) {
    let tag = source.slice(call.params[0].start, call.params[0].end);
    let attributes = [tag]
      .concat((call.hash?.pairs ?? []).map((/** @type {Node} */ pair) => argument(source, pair)))
      .join(" ");

    if (call.type === "GlimmerMustacheStatement") {
      edits.replace(call, `<${attributes} />`);
      continue;
    }

    let text = source.slice(call.start, call.end);
    let opening = OPENING.exec(text)?.[0];
    let closing = CLOSING.exec(text)?.[0];

    if (!opening || !closing) continue;

    let params = call.program?.blockParams ?? [];
    let block = params.length > 0 ? ` as |${params.join(" ")}|` : "";
    let body = text.slice(opening.length, text.length - closing.length);

    edits.replace(call, `<${attributes}${block}>${body}</${tag}>`);
  }

  let output = edits.apply();

  return output.slice(OPEN.length, output.length - "</template>".length);
}

/**
 * Embroider resolves components at build time, so it rejects `{{component <path>}}`,
 * even when the path is a block param: "Unsafe dynamic component".
 * An angle bracket invocation takes the same value, and Embroider accepts it.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "dynamic-components",
  label: "Invoke components that are values with angle brackets",

  detect(project) {
    return project.files(TEMPLATES).some((file) => {
      let source = project.read(file);

      return (
        /\{\{~?#?component\s+[^"'\s(]/.test(source) && angleBracketComponents(source) !== source
      );
    });
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    /** @type {string[]} */
    let changed = [];

    for (let file of project.files(TEMPLATES)) {
      let source = project.read(file);

      if (!/\{\{~?#?component\s+[^"'\s(]/.test(source)) continue;

      let output = angleBracketComponents(source);

      if (output !== source) {
        project.write(file, output);
        changed.push(file);
      }
    }

    recordProgress(project, {
      id: "dynamic-components",
      status: "changed",
      note:
        `${changed.join(", ")} invoke components that are values with angle brackets now, such as \`<btn @value={{1}} />\`, ` +
        "not with `{{component btn value=1}}`, which Embroider cannot resolve at build time.",
      links: [
        "https://github.com/embroider-build/embroider/blob/main/docs/replacing-component-helper.md",
      ],
    });

    return [];
  },
};
