import { parseProgram } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

const FILES = ["{app,tests,addon,lib}/**/*.{ts,gts}"];

/**
 * TS nodes whose children are values, unless the key says otherwise.
 */
const VALUE_TS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSEnumDeclaration",
  "TSEnumMember",
  "TSEnumBody",
  "TSModuleDeclaration",
  "TSModuleBlock",
  "TSParameterProperty",
  "TSExportAssignment",
  "TSImportEqualsDeclaration",
  "TSExternalModuleReference",
  "TSAbstractMethodDefinition",
  "TSAbstractPropertyDefinition",
  "TSAbstractAccessorProperty",
  "TSDeclareFunction",
]);

/**
 * Keys whose children are types, on any node.
 */
const TYPE_KEYS = new Set([
  "typeAnnotation",
  "typeParameters",
  "typeArguments",
  "superTypeArguments",
  "superTypeParameters",
  "returnType",
  "implements",
]);

/**
 * @param {Node} node
 * @param {string[]} names
 * @param {Map<string, boolean>} values set to true for each name that the code reads as a value
 * @param {string} source
 * @param {boolean} inType
 * @param {Node | undefined} parent
 * @param {string | undefined} key
 */
function visit(node, names, values, source, inType, parent, key) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let child of node) visit(child, names, values, source, inType, parent, key);
    return;
  }

  if (typeof node.type !== "string" || node.type === "ImportDeclaration") return;

  /**
   * A template reads the names in its scope as values.
   */
  if (node.type.startsWith("Glimmer")) {
    let text = source.slice(node.start, node.end);

    for (let name of names) {
      if (new RegExp(`(^|[^\\w$.@])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(text)) {
        values.set(name, true);
      }
    }

    return;
  }

  if (node.type === "Identifier" && names.includes(node.name) && !inType) {
    let property =
      (parent?.type === "MemberExpression" && key === "property" && !parent.computed) ||
      (parent?.type === "Property" && key === "key" && !parent.computed && !parent.shorthand) ||
      ((parent?.type === "PropertyDefinition" || parent?.type === "MethodDefinition") &&
        key === "key" &&
        !parent.computed);

    if (!property) values.set(node.name, true);
  }

  let typeNode = node.type.startsWith("TS") && !VALUE_TS.has(node.type);

  for (let child in node) {
    if (child === "loc" || child === "range" || child === "parent") continue;

    let childInType = inType || typeNode || TYPE_KEYS.has(child);

    visit(node[child], names, values, source, childInType, node, child);
  }
}

/**
 * Marks each imported binding that the module uses only as a type with `type`.
 * The Babel config of the Vite app removes only the imports that say `type`, and
 * Rolldown stops the build on an import of a name that the module does not export, such as an interface.
 *
 * @param {string} source
 * @param {string} file
 * @returns {string} the same source when each import is a value, or says `type`
 */
export function markTypeImports(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  /** @type {{ declaration: Node, specifiers: Node[] }[]} */
  let imports = [];

  for (let node of /** @type {Node[]} */ (program.body)) {
    if (node.type !== "ImportDeclaration" || node.importKind === "type") continue;

    let specifiers = node.specifiers.filter(
      (/** @type {Node} */ specifier) =>
        specifier.type !== "ImportNamespaceSpecifier" && specifier.importKind !== "type",
    );

    if (specifiers.length > 0) imports.push({ declaration: node, specifiers });
  }

  let names = imports.flatMap(({ specifiers }) =>
    specifiers.map((/** @type {Node} */ specifier) => specifier.local.name),
  );

  if (names.length === 0) return source;

  /** @type {Map<string, boolean>} */
  let values = new Map();

  visit(program, names, values, source, false, undefined, undefined);

  let edits = new Edits(source);

  for (let { declaration, specifiers } of imports) {
    let types = specifiers.filter(
      (/** @type {Node} */ specifier) => !values.get(specifier.local.name),
    );

    if (types.length === 0) continue;

    let onlyTypes =
      types.length === declaration.specifiers.length &&
      declaration.specifiers.every(
        (/** @type {Node} */ specifier) => specifier.type === "ImportSpecifier",
      );

    if (onlyTypes || (types.length === 1 && declaration.specifiers.length === 1)) {
      edits.insert(declaration.start + "import".length, " type");
      continue;
    }

    for (let specifier of types) {
      if (specifier.type === "ImportSpecifier") edits.insert(specifier.start, "type ");
    }
  }

  return edits.apply();
}

/**
 * @type {import('#types.js').Stage}
 */
export default {
  name: "type-imports",
  label: "Mark the imports that TypeScript modules use only as types with `type`",

  detect(project) {
    return project
      .files(FILES)
      .some(
        (file) =>
          !file.endsWith(".d.ts") &&
          markTypeImports(project.read(file), file) !== project.read(file),
      );
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    for (let file of project.files(FILES)) {
      if (file.endsWith(".d.ts")) continue;

      let source = project.read(file);
      let output = markTypeImports(source, file);

      if (output !== source) project.write(file, output);
    }

    return [];
  },
};
