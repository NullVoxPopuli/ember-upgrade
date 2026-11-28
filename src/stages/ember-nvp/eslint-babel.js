import { parseProgram, propertyName, walk } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

export const ESLINT_CONFIGS = ["eslint.config.mjs", "eslint.config.js", "eslint.config.cjs"];

/**
 * The Babel config of an ember.nvp app is an ES module, which Babel loads only asynchronously, and
 * @babel/eslint-parser calls Babel synchronously. `requireConfigFile: false` allows no config file, and still loads one,
 * so the parser gets `configFile: false`, and parses with the options of the ESLint config alone.
 *
 * @param {string} source an ESLint flat config
 * @param {string} file
 * @returns {string} the same source when each `babelOptions` object has `configFile`
 */
export function withoutBabelConfigFile(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);

  walk(program, (node) => {
    if (propertyName(node) !== "babelOptions" || node.value.type !== "ObjectExpression") return;

    let object = node.value;

    if (
      object.properties.some(
        (/** @type {Node} */ property) => propertyName(property) === "configFile",
      )
    )
      return;

    edits.insert(object.start + 1, " configFile: false,");
  });

  return edits.size > 0 ? edits.apply() : source;
}
