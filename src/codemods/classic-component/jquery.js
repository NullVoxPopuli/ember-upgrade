import { parseProgram, walk } from "#ast.js";
import { NestedEdits } from "#codemods/nested-edits.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * jQuery selectors that are not CSS, and the CSS for them.
 */
const SELECTORS = new Map([[":selected", ":checked"]]);

/**
 * The jQuery methods that a DOM element has with the same name.
 */
const SAME = new Set(["focus", "blur", "click", "remove"]);

/**
 * The jQuery methods that remove event listeners.
 * A listener on an element that the component removes goes with it, so a teardown hook can drop the call.
 */
const OFF = new Set(["off", "unbind"]);

/**
 * @param {string} source
 * @param {Node} node
 */
function text(source, node) {
  return source.slice(node.start, node.end);
}

/**
 * @param {string} selector the source of a selector argument
 * @returns {string}
 */
function cssSelector(selector) {
  let result = selector;

  for (let [from, to] of SELECTORS) result = result.replaceAll(from, to);

  return result;
}

/**
 * Replaces jQuery calls on a component's element, `this.$()` and `this.$(selector)`,
 * and on another component's element, `x.$()`, with the DOM API.
 *
 * @param {string} source
 * @param {string} file
 * @param {Set<string>} teardown the methods that run when the element goes away, such as `willDestroyElement`
 * @returns {{ source: string, unreadable: string[] }}
 */
export function rewriteJQuery(source, file, teardown) {
  let program = parseProgram(source, file);
  /** @type {string[]} */
  let unreadable = [];

  if (!program) return { source, unreadable: ["does not parse"] };

  let edits = new NestedEdits(source);
  /** @type {Node[]} */
  let methods = [];

  walk(program, (node, parent) => {
    if (
      (node.type === "MethodDefinition" || node.type === "Property") &&
      teardown.has(node.key?.name)
    ) {
      methods.push(node);
    }

    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "MemberExpression" ||
      node.callee.computed ||
      node.callee.property?.name !== "$"
    ) {
      return;
    }

    let receiver = text(source, node.callee.object);
    let selector = node.arguments[0];

    if (node.arguments.length > 1) {
      unreadable.push(`jQuery with a context: ${text(source, node)}`);
      return;
    }

    let element = selector
      ? `${receiver}.element.querySelector(${cssSelector(text(source, selector))})`
      : `${receiver}.element`;
    /**
     * `this.$()[0]` and `this.$().get(0)` read the element itself.
     */
    if (
      !selector &&
      parent?.type === "MemberExpression" &&
      parent.object === node &&
      parent.computed &&
      parent.property?.type === "Literal" &&
      parent.property.value === 0
    ) {
      edits.replace(parent, () => element);
      return;
    }

    let [first, ...others] = parent?.id?.type === "ArrayPattern" ? parent.id.elements : [];

    if (
      !selector &&
      parent?.type === "VariableDeclarator" &&
      parent.init === node &&
      first?.type === "Identifier" &&
      others.length === 0
    ) {
      edits.replace(parent, () => `${first.name} = ${element}`);
      return;
    }

    let call = parent?.type === "MemberExpression" && parent.object === node ? parent : undefined;
    let method = call && !call.computed ? call.property?.name : undefined;

    if (!call || !method) {
      edits.replace(node, () => element);
      return;
    }

    /**
     * The call of the jQuery method, such as `.val(x)`, and the expression statement around it.
     */
    /** @type {{ node?: Node, statement?: Node }} */
    let invocation = {};

    walk(program, (candidate, candidateParent) => {
      if (candidate.type === "CallExpression" && candidate.callee === call) {
        invocation.node = candidate;
        invocation.statement =
          candidateParent?.type === "ExpressionStatement" ? candidateParent : undefined;
      }
    });

    let outer = invocation.node;

    if (!outer) {
      unreadable.push(`jQuery property: ${text(source, call)}`);
      return;
    }

    let args = outer.arguments.map((/** @type {Node} */ arg) => text(source, arg));
    let statement = invocation.statement;

    /**
     * jQuery changes every element that the selector matches, and reads the first one.
     */
    let each = (/** @type {(element: string) => string} */ change) =>
      selector
        ? `${receiver}.element.querySelectorAll(${cssSelector(text(source, selector))}).forEach((element) => ${change("element")})`
        : change(element);

    switch (method) {
      case "on":
      case "bind":
        if (args.length !== 2) break;
        edits.replace(outer, () =>
          each((target) => `${target}.addEventListener(${args.join(", ")})`),
        );
        return;
      case "val":
        if (args.length === 0) {
          edits.replace(outer, () => `${element}.value`);
          return;
        }
        if (args.length === 1 && statement) {
          edits.replace(outer, () => each((target) => `${target}.value = ${args[0]}`));
          return;
        }
        break;
      case "is":
        if (args.length !== 1) break;
        edits.replace(outer, () => `${element}.matches(${cssSelector(String(args[0]))})`);
        return;
      case "addClass":
      case "removeClass":
      case "toggleClass": {
        if (args.length !== 1) break;
        let name = method.replace("Class", "");

        edits.replace(outer, () => each((target) => `${target}.classList.${name}(${args[0]})`));
        return;
      }
      case "attr":
        if (args.length === 1) {
          edits.replace(outer, () => `${element}.getAttribute(${args[0]})`);
          return;
        }
        if (args.length === 2) {
          edits.replace(outer, () =>
            each((target) => `${target}.setAttribute(${args.join(", ")})`),
          );
          return;
        }
        break;
      case "text":
      case "html":
        if (args.length === 0) {
          edits.replace(
            outer,
            () => `${element}.${method === "text" ? "textContent" : "innerHTML"}`,
          );
          return;
        }
        break;
      case "get":
        if (args.length !== 1 || args[0] !== "0") break;
        edits.replace(outer, () => element);
        return;
      case "find":
        if (args.length !== 1 || selector) break;
        edits.replace(
          outer,
          () => `${receiver}.element.querySelector(${cssSelector(String(args[0]))})`,
        );
        return;
      default:
        if (SAME.has(method) && args.length === 0) {
          edits.replace(outer, () => `${element}.${method}()`);
          return;
        }

        if (OFF.has(method) && statement && methods.some((hook) => contains(hook, statement))) {
          edits.replace(wholeLine(source, statement), () => "");
          return;
        }
    }

    unreadable.push(`jQuery: ${text(source, outer)}`);
  });

  return { source: edits.apply(), unreadable };
}

/**
 * @param {string} source
 * @param {Node} node a statement
 * @returns {{ start: number, end: number }} the statement's lines, when nothing else is on them
 */
function wholeLine(source, node) {
  let start = source.lastIndexOf("\n", node.start - 1) + 1;
  let end = source.indexOf("\n", node.end);

  if (end === -1) end = source.length;

  if (source.slice(start, node.start).trim() === "" && source.slice(node.end, end).trim() === "") {
    return { start, end: Math.min(end + 1, source.length) };
  }

  return node;
}

/**
 * @param {Node} outer
 * @param {{ start: number, end: number }} inner
 */
function contains(outer, inner) {
  return outer.start <= inner.start && inner.end <= outer.end;
}
