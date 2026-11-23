import { NestedEdits } from "#codemods/nested-edits.js";

import { angleName, findInvocations, rangeOf } from "./invocations.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('./invocations.js').Invocation} Invocation */

/**
 * @typedef {object} Converted
 * @property {string[]} positionalParams
 * @property {boolean} hasElement the Glimmer version renders an element, which takes `class` and `id` as attributes
 * @property {Map<string, string>} callbacks the arguments that the component sets, and their callback arguments
 */

/**
 * The arguments that a classic component turned into attributes of its element.
 */
const ATTRIBUTES = new Map([
  ["class", "class"],
  ["classNames", "class"],
  ["id", "id"],
  ["elementId", "id"],
]);

/**
 * @param {string} template
 * @param {Node} node
 * @returns {string}
 */
function sourceOf(template, node) {
  let range = rangeOf(node);

  return template.slice(range.start, range.end);
}

/**
 * @param {string} template
 * @param {Node} value a curly argument's value
 * @returns {string} the value of an angle bracket argument or attribute
 */
function angleValue(template, value) {
  let text = sourceOf(template, value);

  if (value.type === "GlimmerStringLiteral") return text;
  if (value.type === "GlimmerSubExpression") return `{{${text.slice(1, -1)}}}`;

  return `{{${text}}}`;
}

/**
 * @param {Node | undefined} value
 * @param {string} template
 * @returns {string | undefined} the path that the caller can update with `mut`, such as `this.value`
 */
function mutablePath(value, template) {
  if (value?.type !== "GlimmerPathExpression") return;

  let text = sourceOf(template, value);

  return text.startsWith("this.") ? text : undefined;
}

/**
 * @param {Invocation} invocation
 * @param {Converted} component
 * @returns {{ name: string, value: Node }[] | undefined} the arguments, with positional arguments as named; undefined when there are more positional arguments than names
 */
function curlyArgs(invocation, component) {
  let node = invocation.node;
  let params = invocation.kind === "component" ? node.params.slice(1) : node.params;

  if (params.length > component.positionalParams.length) return;

  /** @type {{ name: string, value: Node }[]} */
  let args = params.map((/** @type {Node} */ value, /** @type {number} */ index) => ({
    name: String(component.positionalParams[index]),
    value,
  }));

  for (let pair of node.hash?.pairs ?? []) args.push({ name: String(pair.key), value: pair.value });

  return args;
}

/**
 * Rewrites where a template invokes converted components: curly invocations become angle brackets,
 * positional arguments become named arguments, and each argument that the component sets
 * gets its callback, as `@onValueChange={{fn (mut this.value)}}`.
 *
 * @param {string} template
 * @param {Map<string, Converted>} components each converted component, by its name, such as `svg-icon`
 * @returns {{ template: string, unreadable: string[] }}
 */
export function rewriteCallers(template, components) {
  /** @type {string[]} */
  let unreadable = [];
  let edits = new NestedEdits(template);

  for (let [name, component] of components) {
    for (let invocation of findInvocations(template, name)) {
      let render = rewriteInvocation(template, name, invocation, component, unreadable, edits);

      if (render) edits.replace(rangeOf(invocation.node), render);
    }
  }

  return { template: edits.apply(), unreadable };
}

/**
 * @param {string} template
 * @param {string} name
 * @param {Invocation} invocation
 * @param {Converted} component
 * @param {string[]} unreadable
 * @param {NestedEdits} edits
 * @returns {(() => string) | undefined} the new invocation, or undefined to keep it
 */
function rewriteInvocation(template, name, invocation, component, unreadable, edits) {
  let node = invocation.node;
  let body = () => (node.program ? edits.print(rangeOf(node.program)) : "");

  if (invocation.kind === "angle") {
    let present = new Set(
      node.attributes.map((/** @type {Node} */ attribute) => String(attribute.name)),
    );
    /** @type {string[]} */
    let added = [];

    for (let attribute of node.attributes) {
      let arg = String(attribute.name).slice(1);
      let callback = component.callbacks.get(arg);
      let path = mutablePath(attribute.value?.path, template);

      if (!callback || present.has(`@${callback}`) || !path || attribute.value?.params?.length) {
        continue;
      }

      added.push(` @${callback}={{fn (mut ${path})}}`);
    }

    /**
     * A classic component put `@class` and `@id` on its element. The Glimmer version takes them as attributes.
     */
    let renamed = component.hasElement
      ? node.attributes.filter(
          (/** @type {Node} */ attribute) =>
            String(attribute.name).startsWith("@") &&
            ATTRIBUTES.has(String(attribute.name).slice(1)) &&
            !present.has(ATTRIBUTES.get(String(attribute.name).slice(1))),
        )
      : [];

    if (added.length === 0 && renamed.length === 0) return;

    let range = rangeOf(node);
    let offset = range.start + 1 + angleName(name).length;

    return () => {
      let rest = edits.print({ start: offset, end: range.end });

      for (let attribute of renamed) {
        let text = sourceOf(template, attribute);
        let to = ATTRIBUTES.get(String(attribute.name).slice(1));

        rest = rest.replace(text, `${to}${text.slice(String(attribute.name).length)}`);
      }

      return `${template.slice(range.start, offset)}${added.join("")}${rest}`;
    };
  }

  let args = curlyArgs(invocation, component);

  if (!args) {
    unreadable.push(
      `${name} gets more positional arguments than it names: ${sourceOf(template, node)}`,
    );
    return;
  }

  if (args.some((arg) => arg.name === "tagName")) {
    unreadable.push(`${name} gets a tagName: ${sourceOf(template, node)}`);
    return;
  }

  let present = new Set(args.map((arg) => arg.name));
  /** @type {{ name: string, value: string, angle: string }[]} */
  let callbacks = [];

  for (let arg of args) {
    let callback = component.callbacks.get(arg.name);
    let path = mutablePath(arg.value, template);

    if (callback && path && !present.has(callback)) {
      callbacks.push({
        name: callback,
        value: `(fn (mut ${path}))`,
        angle: `{{fn (mut ${path})}}`,
      });
    }
  }

  if (invocation.kind === "component" || node.inverse) {
    let head = invocation.kind === "component" ? `component "${name}"` : name;
    let named = args
      .map((arg) => `${arg.name}=${sourceOf(template, arg.value)}`)
      .concat(callbacks.map((callback) => `${callback.name}=${callback.value}`));
    let positional = invocation.kind === "component" ? node.params.slice(1) : node.params;

    if (positional.length === 0 && callbacks.length === 0) return;

    let opening = `${head} ${named.join(" ")}`;

    if (invocation.kind === "component" && !node.program) {
      return () => (node.type === "GlimmerSubExpression" ? `(${opening})` : `{{${opening}}}`);
    }

    let range = rangeOf(node);
    let program = node.program;
    let blockParams = program?.blockParams?.length ? ` as |${program.blockParams.join(" ")}|` : "";

    return () =>
      `{{#${opening}${blockParams}}}${edits.print({ start: rangeOf(program).start, end: range.end })}`;
  }

  let tag = angleName(name);
  let attributes = args
    .map((arg) => {
      let attribute = component.hasElement ? ATTRIBUTES.get(arg.name) : undefined;

      return attribute
        ? `${attribute}=${angleValue(template, arg.value)}`
        : `@${arg.name}=${angleValue(template, arg.value)}`;
    })
    .concat(callbacks.map((callback) => `@${callback.name}=${callback.angle}`));
  let opening = `<${tag}${attributes.map((attribute) => ` ${attribute}`).join("")}`;

  if (invocation.kind === "curly") return () => `${opening} />`;

  let program = node.program;
  let blockParams = program?.blockParams?.length ? ` as |${program.blockParams.join(" ")}|` : "";

  return () => `${opening}${blockParams}>${body()}</${tag}>`;
}
