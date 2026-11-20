import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";

/**
 * The extensions that a converted file can have now.
 *
 * @type {Map<string, string[]>}
 */
const RENAMED = new Map([
  [".js", [".gjs"]],
  [".ts", [".gts", ".gjs"]],
]);

/**
 * @param {string} specifier
 * @param {string} fromDirectory absolute
 * @returns {string | undefined} the new specifier, when the old one names a file that is gone
 */
function renamed(specifier, fromDirectory) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return;

  let match = specifier.match(/\.(js|ts)$/);

  if (!match || existsSync(join(fromDirectory, specifier))) return;

  let base = specifier.slice(0, -match[0].length);

  for (let extension of RENAMED.get(match[0]) ?? []) {
    if (existsSync(join(fromDirectory, base + extension))) return base + extension;
  }
}

/**
 * The template-tag codemod writes imports to the file names from before the conversion.
 * A component that had only a .js class and an .hbs template is a .gjs file after the conversion,
 * so `../components/jumbo.js` no longer resolves.
 *
 * @param {string} source
 * @param {string} file absolute
 * @returns {string}
 */
export function fixImports(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);
  let from = dirname(file);

  walk(program, (node) => {
    let literal =
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ImportExpression"
        ? node.source
        : undefined;

    if (literal?.type !== "Literal" || typeof literal.value !== "string") return;

    let next = renamed(literal.value, from);

    if (!next) return;

    let quote = source[literal.start];

    edits.replace(literal, `${quote}${next}${quote}`);
  });

  return edits.size > 0 ? edits.apply() : source;
}
