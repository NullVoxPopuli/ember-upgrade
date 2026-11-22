/**
 * @typedef {object} MacroCall
 * @property {string} name the macro, such as `alias`
 * @property {{ text: string, string?: string }[]} args each argument's source, and its value when it is a string literal
 */

/**
 * @typedef {object} Getter
 * @property {string} body the getter's return expression
 * @property {Set<string>} imports the names that the body needs, as `module:name`
 * @property {boolean} [setter] the macro also set its dependent key, such as `alias`
 */

const NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * @param {string} path a dependent key, such as `a.b`
 * @param {string} [root]
 * @returns {string} such as `this.a?.b`
 */
export function readPath(path, root = "this") {
  let [first = "", ...rest] = path.split(".");
  let head = NAME.test(first) ? `${root}.${first}` : `${root}[${JSON.stringify(first)}]`;

  return rest.reduce(
    (expression, key) =>
      NAME.test(key) ? `${expression}?.${key}` : `${expression}?.[${JSON.stringify(key)}]`,
    head,
  );
}

/**
 * The computed macros of `@ember/object/computed`, as the body of a native getter.
 *
 * @param {MacroCall} call
 * @param {(key: string) => string} [root] the object that a dependent key starts at, by its first key
 * @returns {Getter | undefined} undefined for a macro that has no plain getter form
 */
export function macroGetter(call, root = () => "this") {
  let { name, args } = call;
  let keys = args.map((arg) => arg.string);
  let key = keys[0];
  let thisPath = (/** @type {string} */ value) =>
    readPath(value, root(value.split(".")[0] ?? value));
  let path = key === undefined ? undefined : thisPath(key);
  /** @type {Set<string>} */
  let imports = new Set();
  let second = args[1]?.text;

  if (args.length === 0) return;

  /**
   * The macros that take only dependent keys.
   */
  let allKeys = keys.every((value) => value !== undefined);
  let paths = allKeys ? /** @type {string[]} */ (keys).map((value) => thisPath(value)) : [];

  switch (name) {
    case "alias":
      return path && args.length === 1 ? { body: path, imports, setter: true } : undefined;
    case "reads":
    case "oneWay":
    case "readOnly":
      return path && args.length === 1 ? { body: path, imports } : undefined;
    case "not":
      return path && args.length === 1 ? { body: `!${path}`, imports } : undefined;
    case "bool":
      return path && args.length === 1 ? { body: `Boolean(${path})`, imports } : undefined;
    case "and":
      return allKeys ? { body: paths.join(" && "), imports } : undefined;
    case "or":
      return allKeys ? { body: paths.join(" || "), imports } : undefined;
    case "equal":
      return path && second ? { body: `${path} === ${second}`, imports } : undefined;
    case "gt":
      return path && second ? { body: `${path} > ${second}`, imports } : undefined;
    case "gte":
      return path && second ? { body: `${path} >= ${second}`, imports } : undefined;
    case "lt":
      return path && second ? { body: `${path} < ${second}`, imports } : undefined;
    case "lte":
      return path && second ? { body: `${path} <= ${second}`, imports } : undefined;
    case "empty":
      if (!path || args.length !== 1) return;
      imports.add("@ember/utils:isEmpty");
      return { body: `isEmpty(${path})`, imports };
    case "notEmpty":
      if (!path || args.length !== 1) return;
      imports.add("@ember/utils:isEmpty");
      return { body: `!isEmpty(${path})`, imports };
    case "none":
      if (!path || args.length !== 1) return;
      imports.add("@ember/utils:isNone");
      return { body: `isNone(${path})`, imports };
    case "match":
      return path && second ? { body: `${second}.test(${path})`, imports } : undefined;
    case "mapBy": {
      let property = args[1]?.string;

      if (!path || property === undefined || args.length !== 2) return;

      return { body: `(${path} ?? []).map((item) => ${readPath(property, "item")})`, imports };
    }
    case "filterBy": {
      let property = args[1]?.string;

      if (!path || property === undefined || args.length > 3) return;

      let test = args[2]
        ? `${readPath(property, "item")} === ${args[2].text}`
        : readPath(property, "item");

      return { body: `(${path} ?? []).filter((item) => ${test})`, imports };
    }
    case "sum":
      return path && args.length === 1
        ? { body: `(${path} ?? []).reduce((total, value) => total + value, 0)`, imports }
        : undefined;
    case "max":
      return path && args.length === 1
        ? { body: `(${path} ?? []).reduce((a, b) => Math.max(a, b), -Infinity)`, imports }
        : undefined;
    case "min":
      return path && args.length === 1
        ? { body: `(${path} ?? []).reduce((a, b) => Math.min(a, b), Infinity)`, imports }
        : undefined;
    case "uniq":
    case "uniqBy": {
      if (!path) return;

      if (name === "uniq" && args.length === 1) {
        return { body: `Array.from(new Set(${path} ?? []))`, imports };
      }

      let property = args[1]?.string;

      if (name !== "uniqBy" || property === undefined || args.length !== 2) return;

      let byKey = (/** @type {string} */ item) => readPath(property, item);

      return {
        body: `(${path} ?? []).filter((item, index, all) => all.findIndex((other) => ${byKey("other")} === ${byKey("item")}) === index)`,
        imports,
      };
    }
    case "collect":
      return allKeys ? { body: `[${paths.join(", ")}]`, imports } : undefined;
  }
}
