import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { parseProgram } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * The template keywords that are also names of app components, such as `<Action>` for app/components/action.gts.
 * The codemod reads such a name as the keyword, and imports no component for it.
 */
const KEYWORDS = new Set([
  "action",
  "component",
  "debugger",
  "each",
  "helper",
  "input",
  "let",
  "log",
  "modifier",
  "mount",
  "mut",
  "outlet",
  "textarea",
  "unbound",
  "unless",
  "with",
  "yield",
]);

const EXTENSIONS = [".gjs", ".gts", ".js", ".ts"];
const TEMPLATE = /<template>[\s\S]*?<\/template>/g;

/**
 * @param {string} name such as `Action`
 * @returns {string} such as `action`
 */
function dasherize(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * @param {string} root the app's folder
 * @param {string} name such as `action`
 * @returns {string | undefined} the component file, such as `app/components/action.gts`
 */
function componentFile(root, name) {
  for (let base of [`app/components/${name}`, `app/components/${name}/index`]) {
    for (let extension of EXTENSIONS) {
      if (existsSync(join(root, base + extension))) return base + extension;
    }
  }
}

/**
 * @param {string} source a .gjs or .gts module
 * @param {string} file relative to the app, such as `app/components/editable-field.gts`
 * @param {string} root the app's folder
 * @returns {string} the source with an import of each app component that a template invokes by a keyword name
 */
export function withKeywordComponents(source, file, root) {
  let templates = source.match(TEMPLATE);

  if (!templates) return source;

  let script = source.replace(TEMPLATE, "");
  /** @type {Map<string, string>} */
  let imports = new Map();

  for (let template of templates) {
    for (let [, name] of template.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) {
      let dashed = dasherize(String(name));

      if (!KEYWORDS.has(dashed) || imports.has(String(name))) continue;
      if (new RegExp(`\\b${name}\\b`).test(script)) continue;
      if (new RegExp(`\\bas\\s*\\|[^|]*\\b${name}\\b[^|]*\\|`).test(template)) continue;

      let target = componentFile(root, dashed);

      if (!target || target === file) continue;

      let specifier = relative(dirname(file), target)
        .split("\\")
        .join("/")
        .replace(/\.(gjs|gts|js|ts)$/, "");

      imports.set(String(name), specifier.startsWith(".") ? specifier : `./${specifier}`);
    }
  }

  if (imports.size === 0) return source;

  let program = parseProgram(source, file);
  let last = program?.body
    .filter((/** @type {Node} */ node) => node.type === "ImportDeclaration")
    .pop();
  let lines = Array.from(imports, ([name, specifier]) => `import ${name} from '${specifier}';`);
  let edits = new Edits(source);

  edits.insert(last ? last.end : 0, last ? `\n${lines.join("\n")}` : `${lines.join("\n")}\n`);

  return edits.apply();
}
