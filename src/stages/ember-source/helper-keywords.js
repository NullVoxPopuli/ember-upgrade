import { SKIP, parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

export const KEYWORD_FILES = ["{app,addon,tests}/**/*.{gjs,gts}"];

/**
 * The helpers of @ember/helper that templates of ember-source 7.4 have as keywords.
 */
const KEYWORDS = new Set(["array", "hash"]);

/**
 * Removes the imports of `array` and `hash` from @ember/helper, which templates have as keywords now.
 * An import stays when the module's code, outside its templates, reads the binding, or names it another way.
 *
 * @param {string} source a .gjs or .gts module
 * @param {string} file
 * @returns {string} the same source when nothing changes
 */
export function withoutKeywordImports(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  /** @type {Set<string>} */
  let readInCode = new Set();

  walk(program, (node, parent) => {
    if (node.type === "ImportDeclaration") return SKIP;
    if (node.type !== "Identifier") return;
    if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return;
    if (parent?.type === "Property" && parent.key === node && !parent.computed) return;

    readInCode.add(node.name);
  });

  let edits = new Edits(source);
  let changed = false;

  for (let declaration of /** @type {Node[]} */ (program.body)) {
    if (declaration.type !== "ImportDeclaration" || declaration.source.value !== "@ember/helper")
      continue;

    let specifiers = /** @type {Node[]} */ (declaration.specifiers);
    let removed = specifiers.filter(
      (specifier) =>
        specifier.type === "ImportSpecifier" &&
        KEYWORDS.has(specifier.imported.name) &&
        specifier.local.name === specifier.imported.name &&
        !readInCode.has(specifier.local.name),
    );

    if (removed.length === 0) continue;

    changed = true;

    let kept = specifiers.filter((specifier) => !removed.includes(specifier));

    if (kept.length === 0) {
      edits.removeLine(declaration);
      continue;
    }

    let names = kept.map((specifier) => source.slice(specifier.start, specifier.end));
    let quote = source[declaration.source.start];

    edits.replace(
      declaration,
      `import { ${names.join(", ")} } from ${quote}@ember/helper${quote};`,
    );
  }

  return changed ? edits.apply() : source;
}
