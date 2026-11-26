import { SKIP, parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * @param {Node} node
 * @returns {{ names: Set<string>, toTree: boolean }} the identifiers that the node reads, and whether it calls `x.toTree()`
 */
function reads(node) {
  /** @type {Set<string>} */
  let names = new Set();
  let toTree = false;

  walk(node, (child, parent) => {
    if (
      child.type === "CallExpression" &&
      child.callee.type === "MemberExpression" &&
      !child.callee.computed &&
      child.callee.property.name === "toTree"
    ) {
      toTree = true;
    }

    if (child.type !== "Identifier") return;
    if (parent?.type === "MemberExpression" && parent.property === child && !parent.computed)
      return;
    if (parent?.type === "Property" && parent.key === child && !parent.computed) return;

    names.add(child.name);
  });

  return { names, toTree };
}

/**
 * @param {Node} statement
 * @returns {string[]} the names that a `let`, `const`, or `var` statement declares
 */
function declared(statement) {
  if (statement.type !== "VariableDeclaration") return [];

  return statement.declarations
    .filter((/** @type {Node} */ declarator) => declarator.id.type === "Identifier")
    .map((/** @type {Node} */ declarator) => declarator.id.name);
}

/**
 * @param {Node} statement
 * @returns {string | undefined} the name of `const x = require("...")`
 */
function requireName(statement) {
  if (statement.type !== "VariableDeclaration" || statement.declarations.length !== 1) return;

  let [declarator] = statement.declarations;

  if (
    declarator.id.type === "Identifier" &&
    declarator.init?.type === "CallExpression" &&
    declarator.init.callee.type === "Identifier" &&
    declarator.init.callee.name === "require"
  ) {
    return declarator.id.name;
  }
}

/**
 * @param {Node} program
 * @returns {Node[] | undefined} the statements of the function that returns `compatBuild(...)`
 */
function compatBody(program) {
  /** @type {Node[] | undefined} */
  let body;

  walk(program, (node) => {
    if (body || node.type !== "BlockStatement") return;

    let returns = node.body.some(
      (/** @type {Node} */ statement) =>
        statement.type === "ReturnStatement" &&
        statement.argument?.type === "CallExpression" &&
        statement.argument.callee.type === "Identifier" &&
        statement.argument.callee.name === "compatBuild",
    );

    if (returns) body = node.body;
  });

  return body;
}

/**
 * @param {string} source
 * @param {Node} statement
 * @returns {{ start: number, end: number }} the statement with the comment lines just above it
 */
function withComments(source, statement) {
  let start = statement.start;

  for (;;) {
    let lineStart = source.lastIndexOf("\n", start - 1) + 1;
    let previousEnd = lineStart - 1;

    if (previousEnd < 0) break;

    let previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
    let line = source.slice(previousStart, previousEnd).trim();

    if (!line.startsWith("//")) break;

    start = previousStart + source.slice(previousStart, previousEnd).indexOf("//");
  }

  return { start, end: statement.end };
}

/**
 * ember-vite-codemod makes ember-cli-build return `compatBuild(app, buildOnce)`, and leaves the code
 * that post-processed `app.toTree()`, such as a broccoli PostCSS step. Vite does not use that tree,
 * and `toTree()` still runs the whole classic build, with the classic build's checks and errors.
 * This removes the statements that build on `app.toTree()`, and the `require()` calls that only they used.
 *
 * @param {string} source ember-cli-build.js
 * @param {string} file
 * @returns {string} the same source when nothing builds on `app.toTree()`
 */
export function removeDeadTrees(source, file) {
  let program = parseProgram(source, file);
  let body = program && compatBody(program);

  if (!program || !body) return source;

  /** @type {Set<Node>} */
  let removed = new Set();
  /** @type {Set<string>} */
  let dead = new Set();
  let changed = true;

  while (changed) {
    changed = false;

    for (let statement of body) {
      if (removed.has(statement) || statement.type === "ReturnStatement") continue;
      if (statement.type !== "VariableDeclaration" && statement.type !== "ExpressionStatement") {
        continue;
      }

      let { names, toTree } = reads(statement);

      if (!toTree && !Array.from(names).some((name) => dead.has(name))) continue;

      removed.add(statement);
      for (let name of declared(statement)) dead.add(name);
      changed = true;
    }
  }

  if (removed.size === 0) return source;

  let kept = body.filter((statement) => !removed.has(statement));

  if (kept.some((statement) => Array.from(reads(statement).names).some((name) => dead.has(name)))) {
    return source;
  }

  /** @type {Set<string>} */
  let usedByRemoved = new Set();

  for (let statement of removed) {
    for (let name of reads(statement).names) usedByRemoved.add(name);
  }

  /** @type {Set<string>} */
  let usedElsewhere = new Set();

  walk(program, (node, parent) => {
    if (removed.has(node)) return SKIP;
    if (node.type !== "Identifier") return;
    if (parent?.type === "VariableDeclarator" && parent.id === node) return;
    if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return;
    if (parent?.type === "Property" && parent.key === node && !parent.computed) return;

    usedElsewhere.add(node.name);
  });

  let edits = new Edits(source);

  for (let statement of removed) edits.removeLine(withComments(source, statement));

  walk(program, (node) => {
    let name = requireName(node);

    if (name && usedByRemoved.has(name) && !usedElsewhere.has(name)) edits.removeLine(node);
  });

  return edits.apply();
}
