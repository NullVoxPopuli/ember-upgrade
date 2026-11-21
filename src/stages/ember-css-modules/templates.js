import { toTree } from "ember-estree";

import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * @param {unknown} node
 * @param {(node: Node) => void} visit
 */
function walkTemplate(node, visit) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let child of node) walkTemplate(child, visit);
    return;
  }

  let astNode = /** @type {Node} */ (node);

  if (typeof astNode.type === "string") visit(astNode);

  for (let key in astNode) {
    if (key === "loc" || key === "range" || key === "parent" || key === "tokens") continue;

    walkTemplate(astNode[key], visit);
  }
}

/**
 * The text of an attribute value, without its quotes.
 *
 * @param {string} source
 * @param {Node} value
 * @returns {string}
 */
function valueText(source, value) {
  let text = source.slice(value.start, value.end);

  return /^(['"]).*\1$/s.test(text) ? text.slice(1, -1) : text;
}

/**
 * @typedef {object} TemplateResult
 * @property {string} output
 * @property {string[]} leftovers what the human must change, one for each line
 */

/**
 * Moves `local-class` to `class`, and `{{local-class "a"}}` to `{{scoped-class "a"}}`.
 * ember-scoped-css scopes a class in `class` when the component's styles define it.
 * Other classes stay global, as they were in `class` before.
 *
 * @param {string} source an .hbs template
 * @returns {TemplateResult}
 */
export function rewriteTemplate(source) {
  /** @type {string[]} */
  let leftovers = [];
  let tree;

  try {
    tree = /** @type {Node} */ (toTree(source, { templateOnly: true })).ast;
  } catch {
    return { output: source, leftovers: ["the template does not parse"] };
  }

  let edits = new Edits(source);
  /**
   * @param {number} offset
   */
  let line = (offset) => source.slice(0, offset).split("\n").length;

  walkTemplate(tree, (node) => {
    if (node.type === "GlimmerElementNode") {
      let local = node.attributes.find((/** @type {Node} */ a) => a.name === "local-class");
      let global = node.attributes.find((/** @type {Node} */ a) => a.name === "class");

      if (!local) return;

      if (!global) {
        edits.replace({ start: local.start, end: local.start + "local-class".length }, "class");
        return;
      }

      let combined = `${valueText(source, global.value)} ${valueText(source, local.value)}`;

      /**
       * ember-scoped-css scopes each use of a class that the styles define, so a class cannot be both.
       */
      if (global.value.type === "GlimmerTextNode" && local.value.type === "GlimmerTextNode") {
        /** @type {string[]} */
        let globals = global.value.chars.split(/\s+/).filter(Boolean);
        /** @type {string[]} */
        let locals = local.value.chars.split(/\s+/).filter(Boolean);
        let both = locals.filter((name) => globals.includes(name));

        for (let name of both) {
          leftovers.push(
            `line ${line(local.start)}: "${name}" was a global class and a local class`,
          );
        }

        combined = globals.concat(locals.filter((name) => !both.includes(name))).join(" ");
      }
      let original = source[global.value.start];
      let quote = original === "'" || combined.includes('"') ? "'" : '"';

      if (combined.includes(quote)) quote = quote === "'" ? '"' : "'";

      if (combined.includes(quote)) {
        leftovers.push(`line ${line(local.start)}: merge local-class into class`);
        return;
      }

      edits.replace(global, `class=${quote}${combined}${quote}`);
      let start = local.start;

      while (/\s/.test(source[start - 1])) start--;

      edits.replace({ start, end: local.end }, "");
      return;
    }

    /**
     * A curly invocation, such as `{{placeholder.text local-class="a"}}`, passes the class as an argument.
     */
    let pairs = node.type === "GlimmerHash" ? node.pairs : [];
    let local = pairs.find((/** @type {Node} */ pair) => pair.key === "local-class");

    if (local) {
      let global = pairs.find((/** @type {Node} */ pair) => pair.key === "class");
      let scoped = `(scoped-class ${source.slice(local.value.start, local.value.end)})`;

      if (local.value.type !== "GlimmerStringLiteral") {
        leftovers.push(`line ${line(local.start)}: local-class=... is not a string`);
      } else if (global) {
        let value = source.slice(global.value.start, global.value.end);

        let start = local.start;

        while (/\s/.test(source[start - 1])) start--;

        edits.replace(global, `class=(concat ${value} " " ${scoped})`);
        edits.replace({ start, end: local.end }, "");
      } else {
        edits.replace(local, `class=${scoped}`);
      }
    }

    if (
      (node.type === "GlimmerMustacheStatement" || node.type === "GlimmerSubExpression") &&
      node.path?.original === "local-class"
    ) {
      let from = node.hash?.pairs?.find((/** @type {Node} */ pair) => pair.key === "from");

      if (from) {
        leftovers.push(
          `line ${line(node.start)}: {{local-class from=...}} reads the classes of another file`,
        );
        return;
      }

      edits.replace(node.path, "scoped-class");
    }
  });

  return { output: edits.size > 0 ? edits.apply() : source, leftovers };
}
