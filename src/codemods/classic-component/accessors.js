import { parseProgram, walk } from "#ast.js";
import { NestedEdits } from "#codemods/nested-edits.js";

/** @typedef {import('#ast.js').Node} Node */

const NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * Receivers whose `get` and `set` are their own, such as a Map's, and not Ember's.
 */
const NOT_EMBER = /(map|params|headers|cache|storage|registry|formdata|url|cookies|searchparams)$/i;

/**
 * @param {Node | undefined} node
 * @returns {string | undefined}
 */
function stringValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
}

/**
 * @param {string} key a property name
 * @returns {string} the member access on `this`
 */
function member(key) {
  return NAME.test(key) ? `this.${key}` : `this[${JSON.stringify(key)}]`;
}

/**
 * @typedef {object} Accessors
 * @property {string} source
 * @property {Set<string>} imports the names that the new source needs from `@ember/object`
 * @property {Set<string>} sets the keys of `this` that the source sets
 * @property {Set<string>} actions the keys that `sendAction` called
 */

/**
 * Replaces the classic accessors on `this`, such as `this.get('a')` and `this.set('a', 1)`,
 * with native property access.
 * A path with more than one key keeps `get` and `set` from `@ember/object`,
 * because a proxy, such as an ember-data relationship, needs them.
 *
 * @param {string} source
 * @param {string} file
 * @returns {Accessors | undefined} undefined when the file does not parse
 */
export function rewriteAccessors(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  /** @type {Accessors} */
  let result = { source, imports: new Set(), sets: new Set(), actions: new Set() };
  let edits = new NestedEdits(source);
  let text = (/** @type {Node} */ node) => edits.print(node);

  walk(program, (node, parent) => {
    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "MemberExpression" ||
      node.callee.computed
    ) {
      return;
    }

    /**
     * `x.get('key')` on an Ember object, such as another component that the class keeps.
     * `get(x, 'key')` reads the same value from an Ember object, a proxy, and a native class.
     */
    if (node.callee.object?.type !== "ThisExpression") {
      let receiver = node.callee.object;
      let method = node.callee.property?.name;
      let args = node.arguments ?? [];
      let key = stringValue(args[0]);

      if (
        (receiver?.type !== "Identifier" && receiver?.type !== "MemberExpression") ||
        NOT_EMBER.test(source.slice(receiver.start, receiver.end)) ||
        key === undefined ||
        !((method === "get" && args.length === 1) || (method === "set" && args.length === 2))
      ) {
        return;
      }

      result.imports.add(method);
      edits.replace(
        node,
        () =>
          `${method}(${text(receiver)}, ${args.map((/** @type {Node} */ arg) => text(arg)).join(", ")})`,
      );
      return;
    }

    let method = node.callee.property?.name;
    let args = node.arguments ?? [];
    let key = stringValue(args[0]);
    let statement = parent?.type === "ExpressionStatement";
    let wrap = (/** @type {string} */ value) => (statement ? value : `(${value})`);

    switch (method) {
      case "get": {
        if (args.length !== 1) return;

        if (key !== undefined && !key.includes(".")) {
          edits.replace(node, () => member(key));
        } else {
          result.imports.add("get");
          edits.replace(node, () => `get(this, ${text(args[0])})`);
        }
        return;
      }

      case "set": {
        if (args.length !== 2) return;

        if (key !== undefined && !key.includes(".")) {
          result.sets.add(key);
          edits.replace(node, () => wrap(`${member(key)} = ${text(args[1])}`));
        } else {
          if (key !== undefined) result.sets.add(key.split(".")[0] ?? key);
          result.imports.add("set");
          edits.replace(node, () => `set(this, ${text(args[0])}, ${text(args[1])})`);
        }
        return;
      }

      case "getProperties": {
        /** @type {(string | undefined)[]} */
        let keys =
          args.length === 1 && args[0].type === "ArrayExpression"
            ? args[0].elements.map(stringValue)
            : args.map(stringValue);

        if (keys.length === 0 || keys.some((name) => name === undefined || !NAME.test(name))) {
          return;
        }

        edits.replace(node, () => `{ ${keys.map((name) => `${name}: this.${name}`).join(", ")} }`);
        return;
      }

      case "setProperties": {
        let object = args[0];

        if (args.length !== 1 || object?.type !== "ObjectExpression") return;

        let keys = object.properties.map((/** @type {Node} */ property) =>
          property.type === "Property" && !property.computed
            ? (property.key?.name ?? stringValue(property.key))
            : undefined,
        );

        if (keys.some((/** @type {string | undefined} */ name) => name === undefined)) return;

        let simple = keys.every((/** @type {string} */ name) => !name.includes("."));

        for (let name of keys) result.sets.add(name.split(".")[0]);

        if (simple) {
          edits.replace(node, () => `Object.assign(this, ${text(object)})`);
        } else {
          result.imports.add("setProperties");
          edits.replace(node, () => `setProperties(this, ${text(object)})`);
        }
        return;
      }

      case "toggleProperty": {
        if (args.length !== 1 || key === undefined || key.includes(".")) return;

        result.sets.add(key);
        edits.replace(node, () => wrap(`${member(key)} = !${member(key)}`));
        return;
      }

      case "incrementProperty":
      case "decrementProperty": {
        if (args.length > 2 || key === undefined || key.includes(".")) return;

        let step = args[1] ? text(args[1]) : "1";
        let sign = method === "incrementProperty" ? "+" : "-";

        result.sets.add(key);
        edits.replace(node, () => wrap(`${member(key)} = (${member(key)} || 0) ${sign} ${step}`));
        return;
      }

      case "sendAction": {
        let name = args.length === 0 ? "action" : key;

        if (name === undefined) return;

        let rest = () =>
          args
            .slice(1)
            .map((/** @type {Node} */ arg) => text(arg))
            .join(", ");

        result.actions.add(name);
        edits.replace(node, () => `${member(name)}?.(${rest()})`);
        return;
      }
    }
  });

  result.source = edits.apply();

  return result;
}
