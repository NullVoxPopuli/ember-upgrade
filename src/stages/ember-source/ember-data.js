import { parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { importMap } from "#codemods/imports.js";

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

  return result.unreadable;
}
