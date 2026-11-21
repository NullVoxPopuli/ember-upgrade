import { parseProgram, propertyName, walk } from "#ast.js";
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
 *
 * @param {import('#project.js').Project} project
 * @param {string[]} names
 * @returns {string[]} the options that were there
 */
export function removeBuildOptions(project, names) {
  let file = buildFile(project);

  if (!file) return [];

  let source = project.read(file);
  let program = parseProgram(source, file);

  if (!program) return [];

  let edits = new Edits(source);
  /** @type {string[]} */
  let removed = [];

  walk(program, (node) => {
    if (node.type !== "NewExpression" || node.arguments[1]?.type !== "ObjectExpression") return;

    for (let property of node.arguments[1].properties) {
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
