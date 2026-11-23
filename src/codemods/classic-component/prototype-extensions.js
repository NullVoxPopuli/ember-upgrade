import { parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { importMap, updateImports } from "#codemods/imports.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * The function prototype extensions, and the function that replaces each one.
 */
const EXTENSIONS = new Map([
  ["on", { module: "@ember/object/evented", name: "on" }],
  ["observes", { module: "@ember/object", name: "observer" }],
  ["property", { module: "@ember/object", name: "computed" }],
]);

/**
 * Rewrites the function prototype extensions, such as `function () {}.on('didInsertElement')`,
 * into the functions of the module API, such as `on('didInsertElement', function () {})`.
 *
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
export function rewritePrototypeExtensions(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let imports = importMap(program);
  let edits = new Edits(source);
  /** @type {Map<string, Set<string>>} */
  let add = new Map();

  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee?.type !== "MemberExpression") return;

    let fn = node.callee.object;

    while (fn?.type === "ParenthesizedExpression") fn = fn.expression;

    let extension = EXTENSIONS.get(node.callee.property?.name);

    if (!extension || node.callee.computed) return;
    if (fn?.type !== "FunctionExpression" && fn?.type !== "ArrowFunctionExpression") return;

    let local = imports.get(extension.name);

    if (local && (local.module !== extension.module || local.imported !== extension.name)) return;

    let args = node.arguments.map((/** @type {Node} */ arg) => source.slice(arg.start, arg.end));

    args.push(source.slice(fn.start, fn.end));
    edits.replace(node, `${extension.name}(${args.join(", ")})`);

    let names = add.get(extension.module) ?? new Set();

    names.add(extension.name);
    add.set(extension.module, names);
  });

  if (add.size === 0) return source;

  return updateImports(edits.apply(), file, { prune: [], add });
}
