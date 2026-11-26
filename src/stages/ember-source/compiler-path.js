import { parseProgram, propertyName, walk } from "#ast.js";
import { removeProperty } from "#config-files.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

export const BABEL_CONFIGS = ["babel.config.cjs", "babel.config.mjs", "babel.config.js"];

/**
 * ember-source 7 has no dist/ember-template-compiler.js, and babel-plugin-ember-template-compilation
 * finds the compiler of the app's ember-source by itself. Older Vite app blueprints passed the path.
 *
 * @param {string} source a Babel config
 * @param {string} file
 * @returns {string} the same source when no option names a file of ember-source
 */
export function withoutCompilerPath(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);
  let found = false;

  walk(program, (node) => {
    if (
      propertyName(node) === "compilerPath" &&
      node.value.type === "Literal" &&
      typeof node.value.value === "string" &&
      node.value.value.startsWith("ember-source/")
    ) {
      removeProperty(edits, node);
      found = true;
    }
  });

  return found ? edits.apply() : source;
}
