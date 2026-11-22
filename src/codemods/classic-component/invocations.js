import { toTree } from "ember-estree";

/** @typedef {import('#ast.js').Node} Node */

const OPEN = "<template>";
const CLOSE = "</template>";

/**
 * @typedef {object} Invocation
 * @property {"curly" | "block" | "angle" | "component"} kind
 * @property {string[]} named the named arguments that the caller passes
 * @property {number} positional how many positional arguments the caller passes
 * @property {Node} node with `start` and `end` in the template
 */

/**
 * @param {string} name a component name, such as `foo/bar-baz`
 * @returns {string} its angle bracket name, such as `Foo::BarBaz`
 */
export function angleName(name) {
  return name
    .split("/")
    .map((part) =>
      part
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(""),
    )
    .join("::");
}

/**
 * @param {unknown} node
 * @param {(node: Node) => void} visit
 */
function walkAll(node, visit) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let child of node) walkAll(child, visit);
    return;
  }

  let astNode = /** @type {Node} */ (node);

  if (typeof astNode.type === "string") visit(astNode);

  for (let key in astNode) {
    if (key === "loc" || key === "range" || key === "parent" || key === "tokens") continue;

    walkAll(astNode[key], visit);
  }
}

/**
 * @param {string} template the source of an .hbs file
 * @returns {Node} the template's tree, with `start` and `end` as offsets into `<template>` + template
 */
export function parseTemplate(template) {
  return /** @type {Node} */ (toTree(`${OPEN}${template}${CLOSE}`, { filePath: "template.gjs" }));
}

/**
 * @param {Node} node a node of {@link parseTemplate}'s tree
 * @returns {{ start: number, end: number }} its offsets in the template
 */
export function rangeOf(node) {
  return { start: node.start - OPEN.length, end: node.end - OPEN.length };
}

/**
 * Finds each place where a template invokes the component.
 *
 * @param {string} template
 * @param {string} name the component's name, such as `svg-icon`
 * @returns {Invocation[]}
 */
export function findInvocations(template, name) {
  let tag = angleName(name);
  /** @type {Invocation[]} */
  let found = [];

  walkAll(parseTemplate(template), (node) => {
    let path = node.path?.original;
    let hashKeys = () =>
      (node.hash?.pairs ?? []).map((/** @type {Node} */ pair) => String(pair.key));

    if (
      (node.type === "GlimmerMustacheStatement" || node.type === "GlimmerBlockStatement") &&
      path === name
    ) {
      found.push({
        kind: node.type === "GlimmerBlockStatement" ? "block" : "curly",
        named: hashKeys(),
        positional: node.params.length,
        node,
      });
      return;
    }

    if (
      (node.type === "GlimmerMustacheStatement" ||
        node.type === "GlimmerSubExpression" ||
        node.type === "GlimmerBlockStatement") &&
      path === "component" &&
      node.params[0]?.type === "GlimmerStringLiteral" &&
      node.params[0].value === name
    ) {
      found.push({
        kind: "component",
        named: hashKeys(),
        positional: node.params.length - 1,
        node,
      });
      return;
    }

    if (node.type === "GlimmerElementNode" && node.tag === tag) {
      found.push({
        kind: "angle",
        named: node.attributes
          .map((/** @type {Node} */ attribute) => String(attribute.name))
          .filter((/** @type {string} */ attribute) => attribute.startsWith("@"))
          .map((/** @type {string} */ attribute) => attribute.slice(1)),
        positional: 0,
        node,
      });
    }
  });

  return found;
}
