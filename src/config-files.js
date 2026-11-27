import { parseProgram, propertyName, SKIP, walk } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

export const BUILD_FILES = ["ember-cli-build.js", "ember-cli-build.cjs"];

const VITE_CONFIGS = ["vite.config.mjs", "vite.config.js", "vite.config.mts", "vite.config.ts"];

/**
 * @param {import('#project.js').Project} project
 * @returns {string | undefined}
 */
export function buildFile(project) {
  return BUILD_FILES.find((file) => project.has(file));
}

/**
 * @param {import('#project.js').Project} project
 * @returns {string | undefined}
 */
export function viteConfig(project) {
  return VITE_CONFIGS.find((file) => project.has(file));
}

/**
 * Removes the property, with its line when the property is the only thing on its lines.
 * The comma after the property goes too. A trailing comma on the property before it is valid.
 *
 * @param {Edits} edits
 * @param {Node} property
 */
export function removeProperty(edits, property) {
  let source = edits.source;
  let start = property.start;
  let end = property.end;
  let lineStart = source.lastIndexOf("\n", start - 1) + 1;

  if (source.slice(lineStart, start).trim() === "") start = lineStart;

  let after = source.slice(end).match(/^\s*,/);

  if (after) end += after[0].length;

  let rest = source.slice(end).match(/^[ \t]*\n/);

  if (rest && start === lineStart) end += rest[0].length;

  edits.replace({ start, end }, "");
}

/**
 * Removes options that the app passes to `new EmberApp(defaults, { ... })`.
 * The options can be in a variable, such as `let options = {}`, with assignments such as
 * `options.inlineContent['x'] = 'y'`. An `if` that only sets removed options goes too,
 * and so does a `require` whose binding nothing reads anymore, such as a flag parser.
 *
 * @param {import('#project.js').Project} project
 * @param {string[]} names
 * @returns {string[]} the options that were there
 */
export function removeBuildOptions(project, names) {
  let file = buildFile(project);

  if (!file) return [];

  let source = project.read(file);
  let result = withoutBuildOptions(source, file, names);

  if (result.source !== source) project.write(file, result.source);

  return result.removed;
}

/**
 * @param {string} source ember-cli-build
 * @param {string} file
 * @param {string[]} names
 * @returns {{ source: string, removed: string[] }}
 */
export function withoutBuildOptions(source, file, names) {
  let program = parseProgram(source, file);

  if (!program) return { source, removed: [] };

  let edits = new Edits(source);
  /** @type {Set<string>} */
  let removed = new Set();
  /** @type {Node | undefined} */
  let options;
  /** @type {string | undefined} */
  let variable;

  walk(program, (node) => {
    if (node.type !== "NewExpression" || !node.arguments[1]) return;

    let arg = node.arguments[1];

    if (arg.type === "ObjectExpression") options = arg;
    if (arg.type === "Identifier") variable = arg.name;
  });

  if (variable) {
    walk(program, (node) => {
      if (node.type === "VariableDeclarator" && node.id?.name === variable) {
        if (node.init?.type === "ObjectExpression") options = node.init;
      }
    });
  }

  let properties = options?.properties ?? [];
  let matching = properties.filter((/** @type {Node} */ property) => {
    let name = propertyName(property);

    return name && names.includes(name);
  });

  if (options && matching.length > 0 && matching.length === properties.length) {
    edits.replace(options, "{}");
  } else {
    for (let property of matching) removeProperty(edits, property);
  }

  /**
   * The variables that hold the value of a removed option, such as `guidemakerConfig` in `guidemaker: guidemakerConfig`.
   */
  let optionVariables = new Map();

  for (let property of matching) {
    let name = /** @type {string} */ (propertyName(property));

    removed.add(name);
    if (property.value?.type === "Identifier") optionVariables.set(property.value.name, name);
  }

  /**
   * @param {Node} statement
   * @returns {string | undefined} the option that the statement sets, such as `inlineContent` for `options.inlineContent['x'] = 'y';`,
   * or `guidemaker` for `guidemakerConfig.premberVersionFilter = 'x';`
   */
  let setsOption = (statement) => {
    let target = statement.type === "ExpressionStatement" ? statement.expression : undefined;
    let left = target?.type === "AssignmentExpression" ? target.left : undefined;

    while (left?.type === "MemberExpression" && left.object?.type === "MemberExpression") {
      left = left.object;
    }

    if (left?.type !== "MemberExpression" || left.computed) return;
    if (optionVariables.has(left.object?.name)) return optionVariables.get(left.object.name);
    if (left.object?.name !== variable) return;

    return names.includes(left.property.name) ? left.property.name : undefined;
  };

  if (variable || optionVariables.size > 0) {
    walk(program, (node) => {
      let name = setsOption(node);

      if (name) {
        edits.removeLine(node);
        removed.add(name);
        return;
      }

      let declarator =
        node.type === "VariableDeclaration" && node.declarations.length === 1
          ? node.declarations[0]
          : undefined;

      if (
        optionVariables.has(declarator?.id?.name) &&
        declarator.init?.type === "ObjectExpression"
      ) {
        edits.removeLine(node);
        return SKIP;
      }

      let body =
        node.type === "IfStatement" && !node.alternate
          ? node.consequent.type === "BlockStatement"
            ? node.consequent.body
            : [node.consequent]
          : undefined;

      if (body?.length && body.every((/** @type {Node} */ statement) => setsOption(statement))) {
        edits.removeLine(node);

        for (let statement of body) removed.add(/** @type {string} */ (setsOption(statement)));

        return SKIP;
      }
    });
  }

  if (removed.size === 0) return { source, removed: [] };

  /**
   * Removed statements leave the blank lines that separated them.
   */
  let output = withoutUnusedRequires(edits.apply(), file).replace(/\n([ \t]*\n){2,}/g, "\n\n");

  return { source: output, removed: Array.from(removed) };
}

/**
 * @param {string} source
 * @param {string} file
 * @returns {string} the source without the top-level requires and helper functions whose binding nothing reads
 */
function withoutUnusedRequires(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  /** @type {Map<string, number>} */
  let counts = new Map();

  walk(program, (node) => {
    if (node.type === "Identifier") counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
  });

  let edits = new Edits(source);

  for (let statement of program.body) {
    let declarator = statement.type === "VariableDeclaration" ? statement.declarations : [];
    let only = declarator.length === 1 ? declarator[0] : undefined;
    let init = only?.init;
    let isRequire =
      init?.type === "CallExpression" &&
      init.callee?.name === "require" &&
      only.id?.type === "Identifier";

    let isHelper =
      (init?.type === "FunctionExpression" || init?.type === "ArrowFunctionExpression") &&
      only.id?.type === "Identifier";

    if ((isRequire || isHelper) && counts.get(only.id.name) === 1) edits.removeLine(statement);

    if (statement.type === "FunctionDeclaration" && counts.get(statement.id?.name) === 1) {
      edits.removeLine(statement);
    }
  }

  /**
   * A helper that goes can leave the requires that only it read.
   */
  return edits.size > 0 ? withoutUnusedRequires(edits.apply(), file) : source;
}

/**
 * Removes options that the app passes to `compatBuild(app, buildOnce, { ... })`.
 *
 * @param {import('#project.js').Project} project
 * @param {string[]} names
 * @returns {string[]} the options that were there
 */
export function removeCompatBuildOptions(project, names) {
  let file = buildFile(project);

  if (!file) return [];

  let source = project.read(file);
  let program = parseProgram(source, file);

  if (!program) return [];

  let edits = new Edits(source);
  /** @type {string[]} */
  let removed = [];

  walk(program, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "Identifier" ||
      node.callee.name !== "compatBuild" ||
      node.arguments[2]?.type !== "ObjectExpression"
    ) {
      return;
    }

    for (let property of node.arguments[2].properties) {
      let name = propertyName(property);

      if (name && names.includes(name)) {
        removeProperty(edits, property);
        removed.push(name);
      }
    }
  });

  if (edits.size > 0) project.write(file, edits.apply());

  return removed;
}

/**
 * Finds the `plugins: [...]` array in a Vite config.
 *
 * @param {Node} program
 * @returns {Node | undefined}
 */
function pluginsArray(program) {
  /** @type {Node | undefined} */
  let found;

  walk(program, (node) => {
    if (!found && propertyName(node) === "plugins" && node.value.type === "ArrayExpression") {
      found = node.value;
    }
  });

  return found;
}

/**
 * Adds an import and a plugin call to the Vite config.
 *
 * @param {import('#project.js').Project} project
 * @param {{ importLine: string, call: string, specifier: string, first?: boolean }} plugin first puts the plugin before the others
 * @returns {boolean} false when the config has no `plugins` array to add to
 */
export function addVitePlugin(project, plugin) {
  let file = viteConfig(project);

  if (!file) return false;

  let source = project.read(file);

  if (source.includes(plugin.specifier)) return true;

  let program = parseProgram(source, file);
  let plugins = program && pluginsArray(program);

  if (!program || !plugins) return false;

  let edits = new Edits(source);
  let imports = program.body.filter(
    (/** @type {Node} */ node) => node.type === "ImportDeclaration",
  );
  let lastImport = imports[imports.length - 1];

  edits.insert(
    lastImport ? lastImport.end : 0,
    lastImport ? `\n${plugin.importLine}` : `${plugin.importLine}\n`,
  );

  let first = plugins.elements[0];
  let last = plugins.elements[plugins.elements.length - 1];

  if (plugin.first && first) {
    let lineStart = source.lastIndexOf("\n", first.start - 1) + 1;
    let indent = source.slice(lineStart, first.start);

    edits.insert(
      first.start,
      indent.trim() === "" ? `${plugin.call},\n${indent}` : `${plugin.call}, `,
    );
  } else if (!last) {
    edits.insert(plugins.start + 1, plugin.call);
  } else {
    let lineStart = source.lastIndexOf("\n", last.start - 1) + 1;
    let indent = source.slice(lineStart, last.start);
    let comma = source.slice(last.end).match(/^\s*,/);

    if (indent.trim() === "") {
      let end = last.end + (comma ? comma[0].length : 0);

      edits.insert(end, comma ? `\n${indent}${plugin.call},` : `,\n${indent}${plugin.call}`);
    } else {
      edits.insert(last.end, `, ${plugin.call}`);
    }
  }

  project.write(file, edits.apply());

  return true;
}

/**
 * @param {Node} statement
 * @param {string[]} packages
 * @returns {string[] | undefined} the names that `const x = require("package")` or `const { x } = require("package/y")` declares
 */
function requiredNames(statement, packages) {
  if (statement.type !== "VariableDeclaration" || statement.declarations.length !== 1) return;

  let [declarator] = statement.declarations;
  let init = declarator.init;
  let module =
    init?.type === "CallExpression" && init.callee.name === "require"
      ? init.arguments[0]?.value
      : undefined;

  if (
    typeof module !== "string" ||
    !packages.some((name) => module === name || module.startsWith(`${name}/`))
  ) {
    return;
  }

  if (declarator.id.type === "Identifier") return [declarator.id.name];
  if (declarator.id.type !== "ObjectPattern") return;

  return declarator.id.properties
    .map((/** @type {Node} */ property) =>
      property.value?.type === "Identifier" ? property.value.name : "",
    )
    .filter(Boolean);
}

/**
 * Removes each `require()` of the packages from ember-cli-build, when nothing reads what it declares.
 *
 * @param {import('#project.js').Project} project
 * @param {string[]} packages
 * @returns {string[]} the packages that ember-cli-build still reads
 */
export function removeUnusedRequires(project, packages) {
  let file = buildFile(project);

  if (!file || packages.length === 0) return [];

  let source = project.read(file);
  let program = parseProgram(source, file);

  if (!program) return [];

  /** @type {{ statement: Node, names: string[] }[]} */
  let requires = [];

  walk(program, (node) => {
    let names = requiredNames(node, packages);

    if (names) requires.push({ statement: node, names });
  });

  if (requires.length === 0) return [];

  /** @type {Set<string>} */
  let read = new Set();

  walk(program, (node, parent) => {
    if (requires.some(({ statement }) => statement === node)) return SKIP;
    if (node.type !== "Identifier") return;
    if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return;
    if (parent?.type === "Property" && parent.key === node && !parent.computed) return;

    read.add(node.name);
  });

  let edits = new Edits(source);
  /** @type {string[]} */
  let kept = [];

  for (let { statement, names } of requires) {
    if (names.some((name) => read.has(name))) {
      let module = statement.declarations[0].init.arguments[0].value;

      kept.push(module);
    } else {
      edits.removeLine(statement);
    }
  }

  if (edits.size > 0) project.write(file, edits.apply());

  return kept;
}
