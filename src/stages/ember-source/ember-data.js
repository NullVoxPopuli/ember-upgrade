import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { importMap } from "#codemods/imports.js";
import { NestedEdits } from "#codemods/nested-edits.js";
import { modulePrefix } from "#module-prefix.js";

/** @typedef {import('#ast.js').Node} Node */

const KINDS = new Set(["belongsTo", "hasMany"]);

/**
 * @param {string} type a model name as the code wrote it, such as `emberVersionCompatibility`
 * @returns {string} such as `ember-version-compatibility`
 */
function dasherize(type) {
  return type.replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * @typedef {object} Relationship
 * @property {string} name the field
 * @property {string} type the related model, such as `addon-size`
 * @property {Node} call `belongsTo('version', { ... })`
 * @property {Node | undefined} options
 * @property {Set<string>} keys the options that the call sets
 * @property {string | null | undefined} inverse the `inverse` option, when it is a literal
 * @property {boolean} typeMissing the call has no type, which came from the field's name
 * @property {string} kind `belongsTo` or `hasMany`
 */

/**
 * @param {string} source
 * @param {string} file
 * @returns {Relationship[]}
 */
export function readRelationships(source, file) {
  let program = parseProgram(source, file);
  /** @type {Relationship[]} */
  let relationships = [];

  if (!program) return relationships;

  let imports = importMap(program);

  /**
   * @param {Node | undefined} call
   * @param {Node} key
   */
  let read = (call, key) => {
    if (call?.type !== "CallExpression") return;

    let callee = call.callee;
    let from = callee?.type === "Identifier" ? imports.get(callee.name) : undefined;
    let type = call.arguments[0];

    if (
      !from ||
      !/^@ember-data\/model|^ember-data/.test(from.module) ||
      !KINDS.has(from.imported)
    ) {
      return;
    }

    let name = key.name ?? key.value;
    let written = type?.type === "Literal" && typeof type.value === "string";

    /**
     * `@belongsTo()` took the type from the field's name, which ember-data 5 does not do.
     */
    if (!written && type && type.type !== "ObjectExpression") return;

    let options = written
      ? call.arguments[1]?.type === "ObjectExpression"
        ? call.arguments[1]
        : undefined
      : type;
    let keys = new Set(
      (options?.properties ?? []).map(
        (/** @type {Node} */ property) => property.key?.name ?? property.key?.value,
      ),
    );

    let inverse = (options?.properties ?? []).find(
      (/** @type {Node} */ property) => (property.key?.name ?? property.key?.value) === "inverse",
    )?.value;

    let inferred = dasherize(name);

    relationships.push({
      name,
      type: written
        ? dasherize(type.value)
        : from.imported === "hasMany"
          ? inferred.replace(/s$/, "")
          : inferred,
      typeMissing: !written,
      kind: from.imported,
      call,
      options,
      keys,
      inverse: inverse?.type === "Literal" ? inverse.value : undefined,
    });
  };

  walk(program, (node) => {
    if (node.type === "PropertyDefinition" && node.decorators?.length) {
      for (let decorator of node.decorators) read(decorator.expression, node.key);
    } else if (node.type === "Property") {
      read(node.value, node.key);
    }
  });

  return relationships;
}

/**
 * ember-data 5 asserts that each relationship sets `async` and `inverse`. Before, `async` was `true`,
 * and the inverse was the only relationship of the related model back to this one.
 *
 * @param {Map<string, string>} models each model's source, by its name, such as `addon-size`
 * @returns {{ files: Map<string, string>, unreadable: string[] }} the changed sources, by model name
 */
export function explicitRelationships(models) {
  /** @type {Map<string, Relationship[]>} */
  let all = new Map();

  for (let [name, source] of models) all.set(name, readRelationships(source, `${name}.js`));

  /** @type {Map<string, string>} */
  let files = new Map();
  /** @type {string[]} */
  let unreadable = [];

  for (let [name, relationships] of all) {
    let source = /** @type {string} */ (models.get(name));
    let edits = new Edits(source);

    for (let relationship of relationships) {
      /** @type {string[]} */
      let add = [];

      if (!relationship.keys.has("async")) add.push("async: true");

      if (!relationship.keys.has("inverse")) {
        if (relationship.keys.has("polymorphic") || relationship.keys.has("as")) {
          unreadable.push(
            `${name}.${relationship.name}: a polymorphic relationship needs its inverse`,
          );
          continue;
        }

        let related = all.get(relationship.type);

        if (!related) {
          unreadable.push(
            `${name}.${relationship.name}: the model ${relationship.type} is not in the app`,
          );
        }

        /**
         * A relationship back to this model is the inverse, unless it names another one.
         */
        let back = (related ?? []).filter(
          (other) =>
            other.type === name &&
            other !== relationship &&
            (other.inverse === undefined || other.inverse === relationship.name),
        );

        if (back.length > 1) {
          unreadable.push(
            `${name}.${relationship.name}: ${relationship.type} has ${back.length} relationships back to ${name}`,
          );
          continue;
        }

        add.push(
          `inverse: ${back[0] ? JSON.stringify(back[0].name).replaceAll('"', "'") : "null"}`,
        );
      }

      let { call, options } = relationship;

      if (relationship.typeMissing) {
        edits.insert(
          call.arguments[0]?.start ?? call.end - 1,
          `'${relationship.type}'${options ? ", " : ""}`,
        );
      }

      if (add.length === 0) continue;

      if (options && options.properties.length > 0) {
        edits.insert(options.properties.at(-1).end, `, ${add.join(", ")}`);
      } else if (options) {
        edits.replace(options, `{ ${add.join(", ")} }`);
      } else if (relationship.typeMissing) {
        edits.insert(call.end - 1, `, { ${add.join(", ")} }`);
      } else {
        edits.insert(call.arguments[0].end, `, { ${add.join(", ")} }`);
      }
    }

    if (edits.size > 0) files.set(name, edits.apply());
  }

  return { files, unreadable };
}

/**
 * @param {import('#project.js').Project} project
 * @returns {string[]} the relationships that the stage could not complete
 */
export function explicitRelationshipOptions(project) {
  let paths = project.files(["app/models/**/*.{js,ts}"]);
  let byName = new Map(
    paths.map((file) => [file.replace(/^app\/models\//, "").replace(/\.(js|ts)$/, ""), file]),
  );
  let result = explicitRelationships(
    new Map(Array.from(byName, ([name, file]) => [name, project.read(file)])),
  );

  for (let [name, source] of result.files)
    project.write(/** @type {string} */ (byName.get(name)), source);

  let from = `${modulePrefix(project)}/utils/as-array`;
  let models = new Map(Array.from(byName, ([name, file]) => [name, project.read(file)]));
  let relationships = relationshipNames(models);
  let hasMany = relationshipNames(models, "hasMany");
  let usesArray = false;

  for (let file of project.files(["{app,tests}/**/*.{js,ts,gjs,gts}"])) {
    if (file === "app/utils/as-array.js") continue;

    let before = project.read(file);
    let after = readHasManyAsArray(
      unwrapRelationshipValues(
        nativeArrayMethods(withoutFirstAndLastObject(before, file, from), file, from),
        file,
        relationships,
        from,
      ),
      file,
      hasMany,
      from,
    );

    if (after !== before) project.write(file, after);
    if (after.includes(`from '${from}'`)) usesArray = true;
  }

  if (usesArray && !project.has("app/utils/as-array.js")) {
    mkdirSync(join(project.directory, "app/utils"), { recursive: true });
    project.write("app/utils/as-array.js", AS_ARRAY_SOURCE);
  }

  return result.unreadable;
}

/**
 * The function that the rewritten reads go through, and the module that the app gets for it.
 */
const ARRAY = "asArray";
const ARRAY_MODULE = "app/utils/as-array";

/**
 * The module for apps whose async hasMany relationships and record arrays lost the array extensions.
 */
export const AS_ARRAY_SOURCE = `/**
 * Reads a list as an array. A native array or an ember-data record array stays as it is.
 * An async hasMany gives the records that it loaded, and nothing before they load.
 */
export default function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if ("content" in value) return asArray(value.content);

  let items = [];

  value.forEach?.((item) => items.push(item));

  return items;
}

/**
 * Reads the record of an async belongsTo, which ember-data 5 does not take as a value of another relationship.
 */
export function asRecord(value) {
  return value != null && typeof value === "object" && "content" in value ? value.content : value;
}
`;

/**
 * Record arrays answer index reads and a few native methods, such as `slice`, but not `at`.
 */
const ENDS = new Map([
  ["firstObject", "[0]"],
  ["lastObject", ".slice(-1)[0]"],
]);

/**
 * ember-data 5 record arrays have no `firstObject` and `lastObject`. `[0]` and `slice(-1)[0]` read the same records.
 * A `get()` path through them, such as `get(x, 'list.firstObject.name')`, splits around them.
 *
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
export function withoutFirstAndLastObject(source, file, from = ARRAY_MODULE) {
  if (!/\b(first|last)Object\b/.test(source)) return source;

  let program = parseProgram(source, file);

  if (!program) return source;

  let imports = importMap(program);
  let getLocal = Array.from(imports).find(
    ([, value]) => value.module === "@ember/object" && value.imported === "get",
  )?.[0];
  let needsGet = false;
  let wrapped = false;
  let edits = new Edits(source);
  let text = (/** @type {Node} */ node) => source.slice(node.start, node.end);

  /**
   * @param {string} object the source of the value that the path starts at
   * @param {string} path such as `list.firstObject.name`
   * @returns {string | undefined}
   */
  let rewrite = (object, path) => {
    let parts = path.split(".");

    if (!parts.some((part) => ENDS.has(part))) return;

    let output = object;
    let pending = [];
    let afterArray = false;

    for (let part of parts) {
      let index = ENDS.get(part);

      if (index === undefined) {
        pending.push(part);
        continue;
      }

      if (pending.length > 0) {
        output = afterArray
          ? `${output}${pending.map((part) => `?.${part}`).join("")}`
          : `${getLocal ?? "get"}(${output}, '${pending.join(".")}')`;
        needsGet ||= !afterArray;
        pending = [];
      }

      output = `${ARRAY}(${output})${index}`;
      afterArray = true;
      wrapped = true;
    }

    /**
     * The list can be empty, and get() asserts on undefined, so the rest of the path reads optionally.
     */
    if (pending.length > 0) {
      output = pending.every((part) => /^[A-Za-z_$][\w$]*$/.test(part))
        ? `${output}${pending.map((part) => `?.${part}`).join("")}`
        : `${getLocal ?? "get"}(${output} ?? {}, '${pending.join(".")}')`;
      needsGet ||= !output.includes("?.");
    }

    return output;
  };

  walk(program, (node) => {
    if (node.type !== "CallExpression") return;

    let path = node.arguments.at(-1);

    if (path?.type !== "Literal" || typeof path.value !== "string") return;

    let callee = node.callee;
    let replaced;

    if (callee.type === "Identifier" && callee.name === getLocal && node.arguments.length === 2) {
      replaced = rewrite(text(node.arguments[0]), path.value);
    } else if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.name === "get" &&
      node.arguments.length === 1
    ) {
      replaced = rewrite(text(callee.object), path.value);
    }

    if (replaced) edits.replace(node, replaced);
  });

  if (edits.size === 0) return source;

  let output = edits.apply();

  if (needsGet && !getLocal) output = `import { get } from '@ember/object';\n${output}`;
  if (wrapped) output = `import ${ARRAY} from '${from}';\n${output}`;

  return output;
}

/**
 * The methods that Ember's array prototype extensions added, and that do not change the array.
 * Record arrays of ember-data 5 do not have them, and Ember 6 removed them from native arrays.
 */
const NATIVE = new Map([
  ["filterBy", "filter"],
  ["rejectBy", "filter"],
  ["findBy", "find"],
  ["isAny", "some"],
  ["isEvery", "every"],
]);

const READERS = new Set([
  "mapBy",
  "filterBy",
  "rejectBy",
  "findBy",
  "isAny",
  "isEvery",
  "sortBy",
  "toArray",
  "objectAt",
  "compact",
  "uniq",
]);

/**
 * Rewrites the reading array extensions, such as `list.mapBy('name')`, to native array methods,
 * which both native arrays and record arrays have.
 *
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
export function nativeArrayMethods(source, file, from = ARRAY_MODULE) {
  if (
    !/\.(mapBy|filterBy|rejectBy|findBy|isAny|isEvery|sortBy|toArray|objectAt|compact|uniq)\(/.test(
      source,
    )
  ) {
    return source;
  }

  let program = parseProgram(source, file);

  if (!program) return source;

  let imports = importMap(program);
  let localOf = (/** @type {string} */ module, /** @type {string} */ name) =>
    Array.from(imports).find(
      ([, value]) => value.module === module && value.imported === name,
    )?.[0];
  let get = localOf("@ember/object", "get");
  let compare = localOf("@ember/utils", "compare");
  let needs = { get: false, compare: false, array: false };
  let edits = new NestedEdits(source);
  let print = (/** @type {Node} */ node) => edits.print(node);
  let list = (/** @type {Node} */ node) => {
    let inner = node.type === "ParenthesizedExpression" ? node.expression : node;
    let rewritten =
      inner.type === "CallExpression" &&
      inner.callee?.type === "MemberExpression" &&
      READERS.has(inner.callee.property?.name);

    /**
     * A read that the codemod rewrote gives a native array already.
     */
    if (rewritten) return print(node);

    needs.array = true;

    return `${ARRAY}(${print(inner)})`;
  };

  walk(program, (node) => {
    let callee = node.type === "CallExpression" ? node.callee : undefined;
    let method =
      callee?.type === "MemberExpression" && !callee.computed ? callee.property.name : undefined;

    if (!method || !READERS.has(method)) return;

    let args = node.arguments;
    let literal = args.every(
      (/** @type {Node} */ arg, /** @type {number} */ index) =>
        index > 0 || (arg.type === "Literal" && typeof arg.value === "string"),
    );
    let receiver = callee.object;
    let argText = args.map((/** @type {Node} */ arg) => source.slice(arg.start, arg.end)).join(" ");
    let item =
      ["item", "element", "entry"].find((name) => !new RegExp(`\\b${name}\\b`).test(argText)) ??
      "item";
    let read = (/** @type {string} */ item) => {
      needs.get = true;

      return `${get ?? "get"}(${item}, ${print(args[0])})`;
    };
    let test = (/** @type {string} */ item) =>
      args.length > 1 ? `${read(item)} === ${print(args[1])}` : read(item);
    /** @type {(() => string) | undefined} */
    let render;

    switch (method) {
      case "mapBy":
        if (args.length === 1 && literal)
          render = () => `${list(receiver)}.map((${item}) => ${read(item)})`;
        break;
      case "filterBy":
      case "rejectBy":
      case "findBy":
      case "isAny":
      case "isEvery": {
        if (args.length < 1 || args.length > 2 || !literal) break;

        let native = NATIVE.get(method);
        let not = method === "rejectBy" ? "!" : "";

        render = () =>
          `${list(receiver)}.${native}((${item}) => ${not}${not && args.length > 1 ? `(${test(item)})` : test(item)})`;
        break;
      }
      case "sortBy":
        if (args.length === 0 || !args.every((/** @type {Node} */ arg) => arg.type === "Literal"))
          break;

        render = () => {
          needs.get = true;
          needs.compare = true;

          let parts = args.map(
            (/** @type {Node} */ arg) =>
              `${compare ?? "compare"}(${get ?? "get"}(a, ${print(arg)}), ${get ?? "get"}(b, ${print(arg)}))`,
          );

          return `${list(receiver)}.slice().sort((a, b) => ${parts.join(" || ")})`;
        };
        break;
      case "toArray":
        if (args.length === 0) render = () => `${list(receiver)}.slice()`;
        break;
      case "objectAt":
        if (args.length === 1) render = () => `${list(receiver)}[${print(args[0])}]`;
        break;
      case "compact":
        if (args.length === 0)
          render = () => `${list(receiver)}.filter((${item}) => ${item} != null)`;
        break;
      case "uniq":
        if (args.length === 0) render = () => `Array.from(new Set(${list(receiver)}))`;
        break;
    }

    if (render) edits.replace(node, render);
  });

  if (edits.size === 0) return source;

  let output = edits.apply();
  let lines = [];

  if (needs.get && !get) lines.push(`import { get } from '@ember/object';`);
  if (needs.compare && !compare) lines.push(`import { compare } from '@ember/utils';`);
  if (needs.array && !output.includes(`import ${ARRAY} from`))
    lines.push(`import ${ARRAY} from '${from}';`);

  return lines.length > 0 ? `${lines.join("\n")}\n${output}` : output;
}

/**
 * Wraps the values that the code assigns to relationships, such as `set(review, 'version', get(this, 'addon.latestVersion'))`,
 * in asRecord(), because ember-data 5 does not take the proxy of an async belongsTo there.
 *
 * @param {string} source
 * @param {string} file
 * @param {Set<string>} relationships the names of the relationships of the app's models
 * @param {string} [from]
 * @returns {string}
 */
export function unwrapRelationshipValues(source, file, relationships, from = ARRAY_MODULE) {
  if (relationships.size === 0) return source;

  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);
  let text = (/** @type {Node} */ node) => source.slice(node.start, node.end);
  let wrap = (/** @type {Node} */ value) => {
    if (value.type !== "CallExpression" && value.type !== "MemberExpression") return;

    edits.replace(value, `asRecord(${text(value)})`);
  };

  walk(program, (node) => {
    if (node.type === "CallExpression") {
      let callee = node.callee;
      let isSet =
        (callee.type === "Identifier" && callee.name === "set" && node.arguments.length === 3) ||
        (callee.type === "MemberExpression" &&
          callee.property?.name === "set" &&
          node.arguments.length === 2);
      let key = node.arguments.at(-2);

      if (isSet && key?.type === "Literal" && relationships.has(key.value))
        wrap(node.arguments.at(-1));
    }

    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "MemberExpression" &&
      !node.left.computed &&
      relationships.has(node.left.property.name)
    ) {
      wrap(node.right);
    }
  });

  if (edits.size === 0) return source;

  return `import { asRecord } from '${from}';\n${edits.apply()}`;
}

/**
 * @param {Map<string, string>} models each model's source, by name
 * @param {"belongsTo" | "hasMany"} [kind]
 * @returns {Set<string>} the names of their relationships
 */
export function relationshipNames(models, kind) {
  /** @type {Set<string>} */
  let names = new Set();

  for (let [name, source] of models) {
    for (let relationship of readRelationships(source, `${name}.js`)) {
      if (!kind || relationship.kind === kind) names.add(relationship.name);
    }
  }

  return names;
}

/**
 * The native array methods that ember-data 4 let code call on an async hasMany, through its proxy.
 */
const NATIVE_READS = new Set([
  "filter",
  "map",
  "find",
  "findIndex",
  "some",
  "every",
  "reduce",
  "includes",
  "indexOf",
  "slice",
  "forEach",
  "flatMap",
  "join",
]);

/**
 * A native array method on an async hasMany, such as `get(this, 'result.compatibilities').filter(...)`,
 * reads through asArray(), because ember-data 5 gives a PromiseManyArray, which has none of them.
 *
 * @param {string} source
 * @param {string} file
 * @param {Set<string>} hasMany the names of the hasMany relationships of the app's models
 * @param {string} [from]
 * @returns {string}
 */
export function readHasManyAsArray(source, file, hasMany, from = ARRAY_MODULE) {
  if (hasMany.size === 0) return source;

  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);

  walk(program, (node) => {
    let callee = node.type === "CallExpression" ? node.callee : undefined;

    if (callee?.type !== "MemberExpression" || callee.computed) return;
    if (!NATIVE_READS.has(callee.property.name)) return;

    let object = callee.object;
    let last;

    if (object.type === "MemberExpression" && !object.computed) last = object.property.name;

    let path = object.type === "CallExpression" ? object.arguments.at(-1) : undefined;

    if (
      object.type === "CallExpression" &&
      path?.type === "Literal" &&
      typeof path.value === "string"
    ) {
      let getter = object.callee;
      let isGet =
        (getter.type === "Identifier" && getter.name === "get") ||
        (getter.type === "MemberExpression" && getter.property?.name === "get");

      if (isGet) last = path.value.split(".").at(-1);
    }

    if (!last || !hasMany.has(last)) return;

    edits.replace(object, `${ARRAY}(${source.slice(object.start, object.end)})`);
  });

  if (edits.size === 0) return source;

  let output = edits.apply();

  return output.includes(`import ${ARRAY} from`)
    ? output
    : `import ${ARRAY} from '${from}';\n${output}`;
}
