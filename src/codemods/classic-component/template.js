import { NestedEdits } from "#codemods/nested-edits.js";

import { parseTemplate, rangeOf } from "./invocations.js";
import { writeOuterHtml } from "./outer-html.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('./read.js').ClassicComponent} ClassicComponent */
/** @typedef {import('./args.js').Names} Names */
/** @typedef {import('./glimmer.js').Glimmer} Glimmer */

const NAME = /^[A-Za-z_$][\w$]*$/;
const SKIP_CHILDREN = Symbol("skip children");

/**
 * @param {unknown} node
 * @param {(node: Node) => void | typeof SKIP_CHILDREN} visit
 */
function walkTemplate(node, visit) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let child of node) walkTemplate(child, visit);
    return;
  }

  let astNode = /** @type {Node} */ (node);

  if (typeof astNode.type === "string" && visit(astNode) === SKIP_CHILDREN) return;

  for (let key in astNode) {
    if (key === "loc" || key === "range" || key === "parent" || key === "tokens") continue;

    walkTemplate(astNode[key], visit);
  }
}

/**
 * @typedef {object} TemplateResult
 * @property {string} template
 * @property {string[]} unreadable
 */

/**
 * Rewrites a classic component's template for its Glimmer version:
 * the outer element moves into the template, arguments read as `@x`,
 * and the `action` helper becomes the method, or `fn` with the method.
 *
 * @param {string} template
 * @param {ClassicComponent} component the classic component, as the reader saw it before the conversion
 * @param {Names} names
 * @param {Glimmer} glimmer
 * @returns {TemplateResult}
 */
export function rewriteTemplate(template, component, names, glimmer) {
  /** @type {string[]} */
  let unreadable = [];
  let members = new Set(component.members.map((entry) => entry.name));
  let calls = glimmer.helpers.map((helper) =>
    helper.args.length > 0
      ? `{{this.${helper.name} ${helper.args.join(" ")}}}`
      : `{{(this.${helper.name})}}`,
  );
  let outer = writeOuterHtml(template, component, {
    modifiers: glimmer.modifier ? [`{{this.${glimmer.modifier}}}`] : [],
    start: calls.join(""),
    elementId: glimmer.elementId,
  });
  let source = outer.template;
  let tree = parseTemplate(source);
  let edits = new NestedEdits(source);
  let print = (/** @type {Node} */ node) => edits.print(rangeOf(node));

  walkTemplate(tree, (node) => {
    if (node.type === "GlimmerPathExpression" && node.head?.type === "ThisHead") {
      let [key, ...rest] = node.tail ?? [];

      if (key === "attrs" && rest.length > 0) {
        edits.replace(rangeOf(node), () => `@${rest.join(".")}`);
        return;
      }

      if (key !== undefined && names.args.has(key) && !members.has(key)) {
        edits.replace(rangeOf(node), () => `@${node.tail.join(".")}`);
      }
      return;
    }

    /**
     * A caller's `(fn (mut this.x))` for an argument that this component sets passes its own callback on.
     */
    if (
      (node.type === "GlimmerSubExpression" || node.type === "GlimmerMustacheStatement") &&
      node.path?.original === "fn" &&
      node.params?.length === 1 &&
      node.params[0].type === "GlimmerSubExpression" &&
      node.params[0].path?.original === "mut"
    ) {
      let path = node.params[0].params[0];
      let [key, ...rest] = path?.head?.type === "ThisHead" ? path.tail : [];
      let callback = key === undefined ? undefined : names.callbacks.get(key);

      if (callback && rest.length === 0 && !members.has(key)) {
        let value = `@${callback}`;

        edits.replace(rangeOf(node), () =>
          node.type === "GlimmerMustacheStatement" ? `{{${value}}}` : value,
        );
        return SKIP_CHILDREN;
      }
    }

    if (
      (node.type === "GlimmerSubExpression" || node.type === "GlimmerMustacheStatement") &&
      node.path?.original === "action"
    ) {
      let [target, ...rest] = node.params ?? [];

      if ((node.hash?.pairs ?? []).length > 0 || !target) {
        unreadable.push(`the action helper with named arguments: ${sourceOf(source, node)}`);
        return;
      }

      let value = () => {
        let fn = target.type === "GlimmerStringLiteral" ? `this.${target.value}` : print(target);
        let args = rest.map((/** @type {Node} */ arg) => print(arg));

        return args.length > 0 ? `(fn ${fn} ${args.join(" ")})` : fn;
      };

      if (target.type === "GlimmerStringLiteral" && !NAME.test(target.value)) {
        unreadable.push(`the action ${target.value} has no plain name`);
        return;
      }

      if (node.type === "GlimmerSubExpression") {
        edits.replace(rangeOf(node), value);
      } else {
        edits.replace(rangeOf(node), () => {
          let text = value();

          return `{{${rest.length > 0 ? text.slice(1, -1) : text}}}`;
        });
      }
      return;
    }

    if (node.type === "GlimmerElementModifierStatement" && node.path?.original === "action") {
      unreadable.push(`the action modifier: ${sourceOf(source, node)}`);
    }
  });

  return { template: edits.apply(), unreadable };
}

/**
 * @param {string} source
 * @param {Node} node
 * @returns {string}
 */
function sourceOf(source, node) {
  let range = rangeOf(node);

  return source.slice(range.start, range.end);
}
