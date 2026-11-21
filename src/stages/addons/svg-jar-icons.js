import { dirname, posix, relative } from "node:path";

import { toTree } from "ember-estree";

import { parseProgram } from "#ast.js";
import { buildFile } from "#config-files.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('#project.js').Project} Project */

export const ICONS_MODULE = "app/utils/svg-jar-icons.js";

const SVG_JAR_IMPORT = "ember-svg-jar/helpers/svg-jar";
const LOOKUP = "svgJarIcon";
const COMPONENT = "SvgJarIcon";

/**
 * @param {unknown} node
 * @param {(node: Node) => void} visit
 */
function walkAll(node, visit) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let child of node) walkAll(child, visit);
    return;
  }

  let astNode = /** @type {Node} */ (node);

  if (typeof astNode.type === "string") visit(astNode);

  for (let key in astNode) {
    if (key === "loc" || key === "range" || key === "parent" || key === "tokens") continue;

    walkAll(astNode[key], visit);
  }
}

/**
 * The name that ember-svg-jar gives an icon name, as the codemod reads it:
 * a string, or the first string of a sub-expression such as `(helper "name")`.
 *
 * @param {Node | undefined} param
 * @returns {boolean}
 */
function isStatic(param) {
  if (param?.type === "GlimmerStringLiteral") return true;

  return param?.type === "GlimmerSubExpression" && param.params[0]?.type === "GlimmerStringLiteral";
}

/**
 * @param {string} source
 * @param {Node} pair a hash pair of the svgJar call
 * @returns {string} the same argument as an HTML attribute
 */
function attribute(source, pair) {
  let text = source.slice(pair.value.start, pair.value.end);

  switch (pair.value.type) {
    case "GlimmerStringLiteral":
      return `${pair.key}=${text}`;
    case "GlimmerSubExpression":
      return `${pair.key}={{${text.slice(1, -1)}}}`;
    case "GlimmerBooleanLiteral":
      return pair.value.value ? pair.key : `${pair.key}={{false}}`;
    default:
      return `${pair.key}={{${text}}}`;
  }
}

/**
 * Turns each `{{svgJar <expression> ...}}` into a lookup in the icon map, which @svg-jar/codemod cannot do.
 *
 * @param {string} source a .gjs or .gts file
 * @param {string} file the path of the file, relative to the project
 * @returns {string | undefined} the new source, or undefined when the file has no such call
 */
export function rewriteDynamicIcons(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  let declaration = program.body.find(
    (/** @type {Node} */ node) =>
      node.type === "ImportDeclaration" && node.source.value === SVG_JAR_IMPORT,
  );
  let local =
    declaration?.specifiers.find((/** @type {Node} */ s) => s.type === "ImportDefaultSpecifier")
      ?.local.name ?? "svgJar";

  /** @type {Node[]} */
  let calls = [];

  walkAll(toTree(source, { filePath: file }), (node) => {
    if (node.type === "GlimmerMustacheStatement" && node.path.original === local) calls.push(node);
  });

  let dynamic = calls.filter((call) => !isStatic(call.params[0]));

  if (dynamic.length === 0) return;

  let edits = new Edits(source);

  for (let call of dynamic) {
    let name = source.slice(call.params[0].start, call.params[0].end);
    let attributes = (call.hash?.pairs ?? []).map((/** @type {Node} */ pair) =>
      attribute(source, pair),
    );
    let element = [COMPONENT].concat(attributes).join(" ");

    edits.replace(call, `{{#let (${LOOKUP} ${name}) as |${COMPONENT}|}}<${element} />{{/let}}`);
  }

  let specifier = relative(dirname(file), ICONS_MODULE).split("\\").join("/");

  if (!specifier.startsWith(".")) specifier = `./${specifier}`;

  let importLine = `import ${LOOKUP} from '${specifier}';`;
  let imports = program.body.filter(
    (/** @type {Node} */ node) => node.type === "ImportDeclaration",
  );

  /**
   * The codemod removes the svgJar import once the static calls are components.
   * With no static calls, the codemod does not change the file, so the import goes here.
   */
  if (declaration && dynamic.length === calls.length) {
    edits.replace(declaration, importLine);
  } else if (imports.length > 0) {
    edits.insert(imports[imports.length - 1].end, `\n${importLine}`);
  } else {
    edits.insert(0, `${importLine}\n`);
  }

  return edits.apply();
}

/**
 * @param {Project} project
 * @returns {string[]} the svgJar `sourceDirs`, or ember-svg-jar's default
 */
export function sourceDirs(project) {
  let build = buildFile(project);
  let match = build && project.read(build).match(/sourceDirs\s*:\s*\[([^\]]*)\]/);
  let dirs = match ? Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g), (m) => m[1]) : [];

  return dirs.length > 0 ? dirs : ["public"];
}

/**
 * @param {string} name
 * @param {Set<string>} taken
 */
function identifier(name, taken) {
  let base = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");

  if (!/^[A-Za-z_$]/.test(base)) base = `Icon${base}`;

  let result = base;

  for (let i = 2; taken.has(result); i++) result = `${base}${i}`;

  taken.add(result);

  return result;
}

/**
 * The map from each ember-svg-jar icon name to its @svg-jar/plugin component.
 * ember-svg-jar names an icon by its file name (`stripPath: true` is its default),
 * and the first source dir wins when two files have the same name.
 *
 * @param {Project} project
 * @returns {string}
 */
export function iconsModule(project) {
  let build = buildFile(project);
  let stripPath = !(build && /stripPath\s*:\s*false/.test(project.read(build)));
  /** @type {Map<string, string>} */
  let icons = new Map();

  for (let dir of sourceDirs(project)) {
    for (let file of project.files([`${dir}/**/*.svg`])) {
      let path = posix.relative(dir, file).replace(/\.svg$/, "");
      let name = stripPath ? posix.basename(path) : path;

      if (!icons.has(name)) icons.set(name, file);
    }
  }

  let taken = new Set();
  let lines = [
    "/**",
    " * Each icon that ember-svg-jar found by name, for templates that pick the icon at runtime.",
    " * A caller that passes the component instead of a name does not need this map.",
    " */",
  ];
  let entries = [];

  for (let [name, file] of icons) {
    let id = identifier(name, taken);

    lines.push(
      `import ${id} from '${posix.relative(posix.dirname(ICONS_MODULE), file)}?unsafe-inline';`,
    );
    entries.push(`  ${JSON.stringify(name)}: ${id},`);
  }

  return lines
    .concat(
      "",
      "const ICONS = {",
      entries,
      "};",
      "",
      "/**",
      " * @param {string} name",
      " */",
      `export default function ${LOOKUP}(name) {`,
      "  return ICONS[name];",
      "}",
      "",
    )
    .join("\n");
}
