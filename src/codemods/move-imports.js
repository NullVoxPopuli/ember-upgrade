import { parseProgram } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * Moves named imports to another module, such as `htmlSafe` from `@ember/string` to `@ember/template`.
 *
 * @param {string} source
 * @param {string} file
 * @param {string} from
 * @param {string} to
 * @param {(name: string) => boolean} moves which imported names move
 * @returns {string}
 */
export function moveImports(source, file, from, to, moves) {
  if (!source.includes(from)) return source;

  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);

  for (let node of program.body) {
    if (node.type !== "ImportDeclaration" || node.source.value !== from) continue;

    let text = (/** @type {Node} */ specifier) => source.slice(specifier.start, specifier.end);
    let named = node.specifiers.filter(
      (/** @type {Node} */ specifier) => specifier.type === "ImportSpecifier",
    );
    let moving = named.filter((/** @type {Node} */ specifier) =>
      moves(specifier.imported.name ?? specifier.imported.value),
    );

    if (moving.length === 0) continue;

    let staying = node.specifiers.filter(
      (/** @type {Node} */ specifier) => !moving.includes(specifier),
    );
    let quote = source[node.source.start];
    let line = `import { ${moving.map(text).join(", ")} } from ${quote}${to}${quote};`;

    if (staying.length === 0) {
      edits.replace(node, line);
      continue;
    }

    let defaults = staying.filter(
      (/** @type {Node} */ specifier) => specifier.type !== "ImportSpecifier",
    );
    let others = staying.filter(
      (/** @type {Node} */ specifier) => specifier.type === "ImportSpecifier",
    );
    let clause = defaults
      .map(text)
      .concat(others.length > 0 ? [`{ ${others.map(text).join(", ")} }`] : [])
      .join(", ");

    edits.replace(node, `import ${clause} from ${quote}${from}${quote};\n${line}`);
  }

  return edits.size > 0 ? edits.apply() : source;
}
