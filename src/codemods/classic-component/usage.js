import { walk } from "#ast.js";

import { parseTemplate } from "./invocations.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * @typedef {object} Usage
 * @property {Set<string>} reads the keys of `this` that the code reads
 * @property {Set<string>} writes the keys of `this` that the code sets
 * @property {boolean} leaks the code passes `this` to other code
 */

/**
 * The built-in components and helpers that set the value that they get.
 */
const TWO_WAY = new Map([
  ["Input", ["@value", "@checked"]],
  ["Textarea", ["@value"]],
]);

/**
 * @param {Node | undefined} node
 * @returns {string | undefined} `x` for `this.x` and `this['x']`
 */
function thisKey(node) {
  if (node?.type !== "MemberExpression" || node.object?.type !== "ThisExpression") return;

  if (!node.computed && node.property?.type === "Identifier") return node.property.name;

  if (node.property?.type === "Literal" && typeof node.property.value === "string") {
    return node.property.value;
  }
}

/**
 * @param {Node} node the class, or the `extend` call
 * @returns {Usage}
 */
export function classUsage(node) {
  /** @type {Usage} */
  let usage = { reads: new Set(), writes: new Set(), leaks: false };

  walk(node, (child, parent) => {
    if (
      child.type === "ThisExpression" &&
      ((parent?.type === "CallExpression" && parent.arguments.includes(child)) ||
        parent?.type === "ArrayExpression" ||
        (parent?.type === "Property" && parent.value === child) ||
        (parent?.type === "AssignmentExpression" && parent.right === child))
    ) {
      /**
       * `once(this, fn)` and `get(this, key)` take the component as the target, not as a value to keep.
       */
      let callee = parent?.type === "CallExpression" ? parent.callee : undefined;
      let target =
        callee?.type === "Identifier" &&
        /^(get|set|setProperties|getProperties|once|next|later|scheduleOnce|schedule|debounce|throttle|run|join|bind|guidFor|getOwner|setOwner|registerDestructor|associateDestroyableChild|isDestroying|isDestroyed)$/.test(
          callee.name,
        ) &&
        parent.arguments[0] === child;

      if (!target && !(callee && isObjectAssign(callee))) usage.leaks = true;
    }

    let key = thisKey(child);

    if (key !== undefined) usage.reads.add(key);

    if (child.type === "AssignmentExpression" || child.type === "UpdateExpression") {
      let written = thisKey(child.type === "AssignmentExpression" ? child.left : child.argument);

      if (written !== undefined) usage.writes.add(written);
    }

    /**
     * `set(this, 'a.b', value)` and `Object.assign(this, { a })`, from the accessor rewrite.
     */
    if (child.type === "CallExpression") {
      let callee = child.callee;
      let [target, keys] = child.arguments ?? [];

      if (target?.type !== "ThisExpression") return;

      if (
        callee?.type === "Identifier" &&
        callee.name === "set" &&
        keys?.type === "Literal" &&
        typeof keys.value === "string"
      ) {
        usage.writes.add(keys.value.split(".")[0] ?? keys.value);
      }

      let assign =
        (callee?.type === "MemberExpression" &&
          callee.object?.name === "Object" &&
          callee.property?.name === "assign") ||
        (callee?.type === "Identifier" && callee.name === "setProperties");

      if (assign && keys?.type === "ObjectExpression") {
        for (let property of keys.properties) {
          let name = property.key?.name ?? property.key?.value;

          if (typeof name === "string") usage.writes.add(name.split(".")[0] ?? name);
        }
      }
    }
  });

  return usage;
}

/**
 * @param {Node} callee
 * @returns {boolean} `Object.assign`
 */
function isObjectAssign(callee) {
  return (
    callee.type === "MemberExpression" &&
    callee.object?.name === "Object" &&
    callee.property?.name === "assign"
  );
}

/**
 * @param {Node | undefined} node
 * @returns {string | undefined} `x` for the path `this.x.y`
 */
function pathKey(node) {
  if (node?.type !== "GlimmerPathExpression") return;

  let [head, key] = String(node.original).split(".");

  if (head === "this" && key) return key;
}

/**
 * @param {unknown} node
 * @param {(node: Node) => void} visit
 */
function walkTemplate(node, visit) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let child of node) walkTemplate(child, visit);
    return;
  }

  let astNode = /** @type {Node} */ (node);

  if (typeof astNode.type === "string") visit(astNode);

  for (let key in astNode) {
    if (key === "loc" || key === "range" || key === "parent" || key === "tokens") continue;

    walkTemplate(astNode[key], visit);
  }
}

/**
 * @param {string} template
 * @returns {Usage}
 */
export function templateUsage(template) {
  /** @type {Usage} */
  let usage = { reads: new Set(), writes: new Set(), leaks: false };

  walkTemplate(parseTemplate(template), (node) => {
    let values = (node.params ?? []).concat(
      (node.hash?.pairs ?? []).map((/** @type {Node} */ pair) => pair.value),
    );

    if (
      values.some(
        (/** @type {Node} */ value) =>
          value?.type === "GlimmerPathExpression" && value.original === "this",
      )
    ) {
      usage.leaks = true;
    }

    let key = pathKey(node);

    if (key !== undefined) usage.reads.add(key);

    if (node.type === "GlimmerSubExpression" && node.path?.original === "mut") {
      let written = pathKey(node.params[0]);

      if (written !== undefined) usage.writes.add(written);
    }

    let names = TWO_WAY.get(node.tag);

    if (node.type === "GlimmerElementNode" && names) {
      for (let attribute of node.attributes) {
        if (!names.includes(attribute.name)) continue;

        let written = pathKey(attribute.value?.path);

        if (written !== undefined) usage.writes.add(written);
      }
    }

    if (
      node.type === "GlimmerMustacheStatement" &&
      (node.path?.original === "input" || node.path?.original === "textarea")
    ) {
      for (let pair of node.hash?.pairs ?? []) {
        if (pair.key !== "value" && pair.key !== "checked") continue;

        let written = pathKey(pair.value);

        if (written !== undefined) usage.writes.add(written);
      }
    }
  });

  return usage;
}
