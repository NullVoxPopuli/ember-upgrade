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
      let pairs = node.hash?.pairs ?? [];
      let path = actionValuePath(node);

      if ((pairs.length > 0 && !path) || !target) {
        unreadable.push(`the action helper with named arguments: ${sourceOf(source, node)}`);
        return;
      }

      let value = () => {
        let fn = target.type === "GlimmerStringLiteral" ? `this.${target.value}` : print(target);
        let args = rest.map((/** @type {Node} */ arg) => print(arg));
        let action = args.length > 0 ? `(fn ${fn} ${args.join(" ")})` : fn;

        return path ? `(this.${ACTION_VALUE} ${action} "${path}")` : action;
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

          return `{{${text.startsWith("(") ? text.slice(1, -1) : text}}}`;
        });
      }
      return;
    }

    if (node.type === "GlimmerElementNode") {
      for (let modifier of node.modifiers ?? []) {
        if (modifier.path?.original !== "action") continue;

        let read = readActionModifier(modifier, node, component);

        if ("reason" in read) {
          unreadable.push(`${read.reason}: ${sourceOf(source, modifier)}`);
          continue;
        }

        edits.replace(rangeOf(modifier), () => {
          let fn =
            read.target.type === "GlimmerStringLiteral"
              ? `this.${read.target.value}`
              : print(read.target);
          let args = read.args.map((/** @type {Node} */ arg) => print(arg));
          let action = args.length > 0 ? `(fn ${fn} ${args.join(" ")})` : fn;
          let options = read.options.map(([key, value]) =>
            typeof value === "string" ? `${key}=${value}` : `${key}=${print(value)}`,
          );

          if (read.handler) {
            action = `(this.${ACTION_HANDLER} ${action}${options.map((option) => ` ${option}`).join("")})`;
          }

          return `{{on "${read.event}" ${action}}}`;
        });
      }
    }
  });

  return { template: edits.apply(), unreadable };
}

/**
 * The field that wraps an action for `on`, as the `{{action}}` modifier ran it.
 */
export const ACTION_HANDLER = "handleAction";

/**
 * The field that calls an action with a value of the event, as the `action` helper did with `value=`.
 */
export const ACTION_VALUE = "actionValue";

/**
 * @param {Node} node an `action` helper
 * @returns {string | undefined} the path of its `value=`, such as `target.files`, when that is its only named argument
 */
function actionValuePath(node) {
  let pairs = node.hash?.pairs ?? [];
  let [pair] = pairs;

  if (pairs.length !== 1 || pair.key !== "value" || pair.value.type !== "GlimmerStringLiteral") {
    return;
  }

  return /^[\w$.]+$/.test(pair.value.value) ? pair.value.value : undefined;
}

/**
 * @param {string} template
 * @returns {boolean} an `action` helper of the template needs {@link ACTION_VALUE}
 */
export function needsActionValue(template) {
  let needed = false;

  walkTemplate(parseTemplate(template), (node) => {
    if (
      (node.type === "GlimmerSubExpression" || node.type === "GlimmerMustacheStatement") &&
      node.path?.original === "action" &&
      actionValuePath(node)
    ) {
      needed = true;
    }
  });

  return needed;
}

/**
 * The elements that do something on their own when the user clicks them or submits them.
 */
const HAS_DEFAULT = new Set([
  "a",
  "area",
  "button",
  "details",
  "form",
  "input",
  "label",
  "option",
  "select",
  "summary",
  "textarea",
]);

/**
 * The events of the event dispatcher, which the `{{action}}` modifier takes, that are not the DOM event in lower case.
 */
const EVENT_NAMES = new Map([["doubleClick", "dblclick"]]);

/**
 * @param {Node} element
 * @returns {boolean} the element, or what it renders, can do something on its own that `preventDefault` stops
 */
function hasDefault(element) {
  let found = false;

  walkTemplate(element, (node) => {
    if (found) return SKIP_CHILDREN;

    if (node.type === "GlimmerElementNode") {
      let tag = String(node.tag);
      let type = node.attributes?.find((/** @type {Node} */ entry) => entry.name === "type");
      let plainButton =
        tag === "button" &&
        type?.value?.type === "GlimmerTextNode" &&
        type.value.chars === "button";

      if ((HAS_DEFAULT.has(tag) && !plainButton) || /^[A-Z@:]|\./.test(tag)) found = true;
    }

    if (node.type === "GlimmerMustacheStatement" || node.type === "GlimmerBlockStatement") {
      let path = String(node.path?.original ?? "");

      if (/^(yield|outlet|component)$/.test(path) || path.includes("-")) found = true;
    }
  });

  return found;
}

/**
 * @param {ClassicComponent} component
 * @param {string} name
 * @returns {number | undefined} the number of parameters of the component's method or action
 */
function parameterCount(component, name) {
  for (let entry of component.members) {
    if (entry.kind === "method" && entry.name === name) {
      return (entry.node.value ?? entry.node).params?.length;
    }

    if (entry.kind !== "actions") continue;

    for (let property of entry.node.value?.properties ?? []) {
      let key = property.key?.name ?? property.key?.value;

      if (key === name) return (property.value ?? property).params?.length;
    }
  }
}

/**
 * @typedef {object} ActionModifier
 * @property {string} event the DOM event, such as `click`
 * @property {Node} target the action
 * @property {Node[]} args
 * @property {boolean} handler the action needs {@link ACTION_HANDLER}, to stop the default or the event, or to get no event
 * @property {[string, Node | string][]} options the named arguments for the handler
 */

/**
 * The `{{action}}` modifier listens for a click unless `on` names another event.
 * It calls `preventDefault` unless `preventDefault=false`, stops the event with `bubbles=false`,
 * and does not give the event to the action. `on` gives the event to the function as its last argument.
 *
 * @param {Node} modifier
 * @param {Node} element
 * @param {ClassicComponent} component
 * @returns {ActionModifier | { reason: string }}
 */
export function readActionModifier(modifier, element, component) {
  let [target, ...args] = modifier.params ?? [];

  if (!target) return { reason: "the action modifier without an action" };

  if (target.type === "GlimmerStringLiteral" && !NAME.test(target.value)) {
    return { reason: `the action ${target.value} has no plain name` };
  }

  if (
    target.type !== "GlimmerStringLiteral" &&
    target.type !== "GlimmerPathExpression" &&
    target.type !== "GlimmerSubExpression"
  ) {
    return { reason: "the action modifier with an action that is not a name, a path, or a helper" };
  }

  let event = "click";
  /** @type {Node | undefined} */
  let preventDefault;
  /** @type {Node | undefined} */
  let bubbles;

  for (let pair of modifier.hash?.pairs ?? []) {
    if (pair.key === "on" && pair.value.type === "GlimmerStringLiteral") {
      event = EVENT_NAMES.get(pair.value.value) ?? pair.value.value.toLowerCase();
    } else if (pair.key === "preventDefault") {
      preventDefault = pair.value;
    } else if (pair.key === "bubbles") {
      bubbles = pair.value;
    } else {
      return { reason: `the action modifier with ${pair.key}=` };
    }
  }

  /**
   * The default stays when nothing on the element has one.
   * @type {boolean | Node}
   */
  let prevents = false;

  if (hasDefault(element)) {
    prevents =
      preventDefault?.type === "GlimmerBooleanLiteral"
        ? preventDefault.value
        : (preventDefault ?? true);
  }

  /** @type {[string, Node | string][]} */
  let options = [];

  if (prevents === false) options.push(["preventDefault", "false"]);
  else if (prevents !== true) options.push(["preventDefault", prevents]);

  let stops = bubbles !== undefined && !(bubbles.type === "GlimmerBooleanLiteral" && bubbles.value);

  if (stops && bubbles) options.push(["bubbles", bubbles]);

  /**
   * A method with more parameters than the template passes reads the event as a value it does not expect.
   */
  let count =
    target.type === "GlimmerStringLiteral" ? parameterCount(component, target.value) : undefined;
  let readsEvent = count !== undefined && count > args.length;
  let handler = prevents !== false || stops || readsEvent;

  return {
    event,
    target,
    args,
    handler,
    options: handler ? options : [],
  };
}

/**
 * @param {string} template
 * @param {ClassicComponent} component
 * @returns {boolean} an `{{action}}` modifier of the template needs {@link ACTION_HANDLER}
 */
export function needsActionHandler(template, component) {
  let needed = false;

  walkTemplate(parseTemplate(template), (node) => {
    if (node.type !== "GlimmerElementNode") return;

    for (let modifier of node.modifiers ?? []) {
      if (modifier.path?.original !== "action") continue;

      let read = readActionModifier(modifier, node, component);

      if (!("reason" in read) && read.handler) needed = true;
    }
  });

  return needed;
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
