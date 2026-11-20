import { toTree } from "ember-estree";

/**
 * ember-estree types every property as `unknown`.
 *
 * @typedef {{ type: string, start: number, end: number, [key: string]: any }} Node
 */

/**
 * @param {string} source
 * @param {string} filePath decides the parser: `.ts` and `.gts` parse TypeScript
 * @returns {Node | undefined} the Program, or undefined when the file does not parse
 */
export function parseProgram(source, filePath) {
  let file;

  try {
    file = /** @type {Node} */ (toTree(source, { filePath }));
  } catch {
    return undefined;
  }

  if (Array.isArray(file.errors) && file.errors.length > 0) return undefined;

  return file.program;
}

export const SKIP = Symbol("skip");

/**
 * Calls `visit` for every JS and TS node below `node`, parents first.
 * Template contents are not visited.
 *
 * @param {unknown} node
 * @param {(node: Node, parent: Node | undefined) => void | typeof SKIP} visit return SKIP to leave out the children
 * @param {Node} [parent]
 */
export function walk(node, visit, parent) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let child of node) walk(child, visit, parent);
    return;
  }

  let astNode = /** @type {Node} */ (node);

  if (typeof astNode.type !== "string" || astNode.type.startsWith("Glimmer")) return;

  if (visit(astNode, parent) === SKIP) return;

  for (let key in astNode) {
    if (key === "loc" || key === "range" || key === "parent") continue;

    walk(astNode[key], visit, astNode);
  }
}

/**
 * @param {Node | undefined} node
 * @returns {string | undefined} the name, when the node is a plain Identifier
 */
export function identifierName(node) {
  return node?.type === "Identifier" ? node.name : undefined;
}
