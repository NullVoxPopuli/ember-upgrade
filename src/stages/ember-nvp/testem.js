import { parseProgram, propertyName, walk } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

export const TESTEM_CONFIG = "testem.cjs";

/**
 * The ember.nvp migration keeps a testem.cjs of the app, and its `test:ci` script serves the files from the folder of the config.
 * The built test page is in dist/, so testem serves dist/.
 *
 * @param {string} source a testem config
 * @param {string} file
 * @returns {string} the same source when the config has `cwd`, or has no `test_page`
 */
export function withDistFolder(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);

  walk(program, (node) => {
    if (node.type !== "ObjectExpression") return;

    let properties = node.properties;
    let page = properties.find(
      (/** @type {Node} */ property) => propertyName(property) === "test_page",
    );

    if (!page) return;
    if (properties.some((/** @type {Node} */ property) => propertyName(property) === "cwd")) return;

    let lineStart = source.lastIndexOf("\n", page.start - 1) + 1;
    let indent = source.slice(lineStart, page.start);

    edits.insert(page.start, `cwd: "dist",${/^\s*$/.test(indent) ? `\n${indent}` : " "}`);
  });

  return edits.size > 0 ? edits.apply() : source;
}
