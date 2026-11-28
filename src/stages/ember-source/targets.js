import { parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

export const TARGETS = "config/targets.js";

/**
 * @param {Node | null} element
 */
function internetExplorer(element) {
  return (
    element?.type === "Literal" &&
    typeof element.value === "string" &&
    /^\s*ie\b/i.test(element.value)
  );
}

/**
 * Ember 5 does not support Internet Explorer, and ember-source 5 has no Babel helpers for it.
 * With `ie 11` in the targets, the app's Babel compiles ember-source with helpers that ember-babel does not export.
 *
 * @param {string} source config/targets.js
 * @returns {string} the same source when no target names Internet Explorer
 */
export function withoutInternetExplorer(source) {
  let program = parseProgram(source, TARGETS);

  if (!program) return source;

  let edits = new Edits(source);
  let found = false;

  walk(program, (node) => {
    if (node.type === "ArrayExpression") {
      let elements = /** @type {(Node | null)[]} */ (node.elements);

      for (let index = 0; index < elements.length; index++) {
        let element = elements[index];

        if (!element || !internetExplorer(element)) continue;

        let next = elements[index + 1];
        let previous = elements[index - 1];

        if (next) edits.replace({ start: element.start, end: next.start }, "");
        else if (previous) edits.replace({ start: previous.end, end: element.end }, "");
        else edits.replace(element, "");

        found = true;
      }
    }

    /**
     * `browsers.push('ie 11')`
     */
    if (
      node.type === "ExpressionStatement" &&
      node.expression.type === "CallExpression" &&
      node.expression.callee.property?.name === "push" &&
      node.expression.arguments.length === 1 &&
      internetExplorer(node.expression.arguments[0])
    ) {
      edits.removeLine(node);
      found = true;
    }
  });

  return found ? edits.apply() : source;
}
