import { parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

const APP_FILES = ["app/app.js", "app/app.ts"];

/**
 * @param {Node} program
 * @returns {string | undefined} the local name of the default import from `@ember/application`
 */
function applicationName(program) {
  for (let statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "@ember/application") {
      continue;
    }

    for (let specifier of statement.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") return specifier.local.name;
    }
  }
}

/**
 * @param {Node | undefined} node
 * @param {string} application
 * @returns {Node | undefined} the object of `Application.extend({ ... })`, when each member is a plain value
 */
function extendObject(node, application) {
  if (
    node?.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.object.type !== "Identifier" ||
    node.callee.object.name !== application ||
    node.callee.property.name !== "extend" ||
    node.arguments.length !== 1 ||
    node.arguments[0].type !== "ObjectExpression"
  ) {
    return;
  }

  let object = node.arguments[0];
  let plain = object.properties.every(
    (/** @type {Node} */ property) =>
      property.type === "Property" &&
      property.kind === "init" &&
      !property.method &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.value.type !== "FunctionExpression" &&
      property.value.type !== "ArrowFunctionExpression",
  );

  return plain ? object : undefined;
}

/**
 * @param {string} source
 * @param {string} name
 * @param {string} application
 * @param {Node} object
 */
function classSource(source, name, application, object) {
  let fields = object.properties.map(
    (/** @type {Node} */ property) =>
      `  ${property.key.name} = ${source.slice(property.value.start, property.value.end)};\n`,
  );

  return `class ${name} extends ${application} {\n${fields.join("")}}`;
}

/**
 * Turns `Application.extend({ modulePrefix: ..., Resolver })` into the class of the app blueprint,
 * `class App extends Application { modulePrefix = ...; Resolver = Resolver; }`.
 * Only an object of plain values moves, because class fields keep the same values.
 *
 * @param {string} source app/app.js
 * @param {string} file
 * @returns {string} the same source when the app module has no such call
 */
export function nativeAppClass(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let application = applicationName(program);

  if (!application) return source;

  let edits = new Edits(source);
  /** @type {Map<string, Node>} */
  let declarations = new Map();
  /** @type {Map<string, number>} */
  let assignments = new Map();

  walk(program, (node) => {
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
      assignments.set(node.left.name, (assignments.get(node.left.name) ?? 0) + 1);
    }
  });

  for (let statement of program.body) {
    if (
      statement.type === "VariableDeclaration" &&
      statement.declarations.length === 1 &&
      statement.declarations[0].id.type === "Identifier" &&
      !statement.declarations[0].init
    ) {
      declarations.set(statement.declarations[0].id.name, statement);
    }
  }

  for (let statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      let object = extendObject(statement.declaration, application);

      if (object) {
        edits.replace(
          statement,
          `export default ${classSource(source, "App", application, object)}`,
        );
      }

      continue;
    }

    if (statement.type === "VariableDeclaration" && statement.declarations.length === 1) {
      let [declarator] = statement.declarations;
      let object = extendObject(declarator.init, application);

      if (object && declarator.id.type === "Identifier" && !assignments.has(declarator.id.name)) {
        edits.replace(statement, classSource(source, declarator.id.name, application, object));
      }

      continue;
    }

    let expression = statement.type === "ExpressionStatement" ? statement.expression : undefined;

    if (expression?.type !== "AssignmentExpression" || expression.left.type !== "Identifier") {
      continue;
    }

    let name = expression.left.name;
    let declaration = declarations.get(name);
    let object = extendObject(expression.right, application);

    if (!object || !declaration || assignments.get(name) !== 1) continue;

    edits.removeLine(declaration);
    edits.replace(statement, classSource(source, name, application, object));
  }

  return edits.apply();
}

/**
 * ember.nvp reads the app module of the blueprint, which is a native class.
 * Older apps call `Application.extend()`, and ember.nvp stops on what it cannot read there.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "app-class",
  label: "Turn the Application.extend() of the app module into a native class",

  detect(project) {
    return APP_FILES.some(
      (file) =>
        project.has(file) && nativeAppClass(project.read(file), file) !== project.read(file),
    );
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    for (let file of APP_FILES) {
      if (!project.has(file)) continue;

      let source = project.read(file);
      let output = nativeAppClass(source, file);

      if (output !== source) project.write(file, output);
    }

    return [];
  },
};
