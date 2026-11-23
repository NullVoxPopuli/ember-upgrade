import { stripTypeScriptTypes } from "node:module";

import { parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { updateImports } from "#codemods/imports.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * Removes the TypeScript syntax of a module, for an app that does not compile TypeScript.
 * Node blanks the types, so the blanked characters go, with the spaces inside them,
 * and so do the lines that only held types.
 *
 * @param {string} source
 * @param {string} file a `.ts` or `.gts` path
 * @returns {string | undefined} undefined when the module has TypeScript that does more than type, such as an enum
 */
export function stripTypes(source, file) {
  let erasable = withoutAngleAssertions(source, file);
  let stripped;

  try {
    stripped = stripTypeScriptTypes(erasable, { mode: "strip" });
  } catch {
    return undefined;
  }

  let removed = Array.from(erasable, (char, index) => stripped[index] !== char);
  let space = (/** @type {number} */ index) => erasable[index] === " " || erasable[index] === "\t";
  let neighbor = (/** @type {number} */ index, /** @type {number} */ step) => {
    let at = index + step;

    while (at >= 0 && at < erasable.length && space(at)) at += step;

    return at;
  };

  for (let index = 0; index < erasable.length; index++) {
    if (!space(index) || removed[index]) continue;

    let left = neighbor(index, -1);
    let right = neighbor(index, 1);

    if (removed[left] && removed[right]) removed[index] = true;

    /**
     * `a as any;` keeps no space before the `;`.
     */
    if (removed[right] && !removed[left]) {
      let after = right;

      while (after < erasable.length && (removed[after] || space(after))) after++;

      if (/[;,)\]]/.test(erasable[after] ?? "")) removed[index] = true;
    }
  }

  let output = Array.from(erasable)
    .filter((_, index) => !removed[index])
    .join("");
  let before = erasable.split("\n");
  let javascript = output
    .split("\n")
    .filter((line, index) => line.trim() !== "" || (before[index] ?? "").trim() === "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");

  return withoutTypeOnlyImports(javascript, file.replace(/ts$/, "js"));
}

/**
 * An import that only the types used, such as `Token` in `x as Token`, has nothing to import at runtime.
 *
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
function withoutTypeOnlyImports(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let modules = program.body
    .filter((/** @type {Node} */ node) => node.type === "ImportDeclaration")
    .map((/** @type {Node} */ node) => String(node.source.value));

  return updateImports(source, file, { prune: modules, add: new Map() });
}

/**
 * Node cannot blank `<T>value`, so it becomes `(value)`.
 *
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
function withoutAngleAssertions(source, file) {
  if (!/<[\w.]+(<[^>]*>)?>\s*[\w({[]/.test(source)) return source;

  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);

  walk(program, (node) => {
    if (node.type !== "TSTypeAssertion") return;

    edits.replace(node, `(${source.slice(node.expression.start, node.expression.end)})`);
  });

  return edits.size > 0 ? edits.apply() : source;
}
