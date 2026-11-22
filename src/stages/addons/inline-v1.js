import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";

import { parseProgram, propertyName, walk } from "#ast.js";
import { inlineStage } from "./inline.js";

/** @typedef {import('#project.js').Project} Project */

/**
 * index.js properties that only name the addon. Any other one is a build hook,
 * such as `included` or `treeForVendor`, which ember.nvp apps do not run.
 */
const NAMING = new Set(["name", "moduleName", "isDevelopingAddon"]);

const CODE = /\.(js|ts|gjs|gts|hbs)$/;
const BUILD_DEPENDENCY = /^(ember-cli-|broccoli-|@embroider\/|ember-auto-import$)/;
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;
const REEXPORT =
  /^\s*(import \w+ from ["'][^"']+["'];\s*export default \w+;|export \{ default \} from ["'][^"']+["'];)\s*$/;
const TEMPLATE_IMPORT = /^import (\w+) from (["'])([^"']+)\2;?\n/gm;

/**
 * @typedef {object} Plan
 * @property {Map<string, string>} files the new files, by path in the project
 * @property {Record<string, string>} imports each module of the addon, and the file that has it now
 * @property {Record<string, string>} ranges the addon's runtime dependencies, with its ranges
 */

/**
 * @param {string} directory the installed addon
 * @returns {string[]} the index.js properties that are build hooks
 */
export function buildHooks(directory) {
  let file = join(directory, "index.js");

  if (!existsSync(file)) return [];

  let program = parseProgram(readFileSync(file, "utf8"), file);
  /** @type {string[]} */
  let hooks = [];

  walk(program, (node) => {
    if (
      node.type !== "AssignmentExpression" ||
      node.left?.type !== "MemberExpression" ||
      node.left.object?.name !== "module" ||
      node.right?.type !== "ObjectExpression"
    ) {
      return;
    }

    for (let property of node.right.properties) {
      let name = propertyName(property);

      if (!name || !NAMING.has(name)) hooks.push(name ?? "...");
    }
  });

  return hooks;
}

/**
 * @param {string} path a file of the addon, such as `addon/templates/components/x-select.hbs`
 * @returns {string | undefined} where it goes in the project
 */
export function targetOf(path) {
  if (path.startsWith("addon/templates/components/")) {
    return `app/components/${path.slice("addon/templates/components/".length)}`;
  }

  if (path.startsWith("addon/")) return `app/${path.slice("addon/".length)}`;
  if (path.startsWith("app/")) return path;
  if (path.startsWith("test-support/")) return `tests/${path.slice("test-support/".length)}`;
  if (path.startsWith("addon-test-support/")) {
    return `tests/helpers/${path.slice("addon-test-support/".length)}`;
  }
}

/**
 * @param {string} path
 * @returns {string}
 */
function withoutExtension(path) {
  return path.replace(CODE, "");
}

/**
 * The addon's code as app files. undefined when the addon is not only code that the app can hold:
 * it has build hooks, styles that ember-cli compiled, or no code at all.
 *
 * @param {string} name
 * @param {string} directory where the addon is installed
 * @returns {Plan | undefined}
 */
export function planInline(name, directory) {
  if (buildHooks(directory).length > 0 || existsSync(join(directory, "addon", "styles"))) return;

  let sources = globSync("{addon,app,test-support,addon-test-support}/**/*", {
    cwd: directory,
    exclude: (entry) => entry === "node_modules",
  })
    .map((file) => file.split("\\").join("/"))
    .filter((file) => CODE.test(file))
    .sort();

  if (sources.length === 0) return;

  /** @type {Map<string, string>} module of the addon, without the extension, to its new path */
  let modules = new Map();
  /** @type {Record<string, string>} */
  let imports = {};

  for (let file of sources) {
    let target = targetOf(file);

    if (!target || file.startsWith("app/")) continue;

    modules.set(withoutExtension(file), target);

    if (file.startsWith("addon/")) {
      imports[`${name}/${withoutExtension(file.slice("addon/".length))}`] = target;
    }

    if (file.startsWith("addon-test-support/")) {
      imports[
        `${name}/test-support/${withoutExtension(file.slice("addon-test-support/".length))}`
      ] = target;
    }
  }

  if (imports[`${name}/index`]) imports[name] = imports[`${name}/index`];

  /** @type {Map<string, string>} */
  let files = new Map();

  for (let file of sources) {
    let target = targetOf(file);
    let source = readFileSync(join(directory, file), "utf8");

    if (!target) continue;

    /**
     * The app tree re-exported the addon's modules. A module at the same path is that module now,
     * and a re-exported template is next to its component.
     */
    if (file.startsWith("app/")) {
      let reexported = /from\s*["']([^"']+)["']/.exec(source)?.[1];
      let module = reexported ? imports[reexported] : undefined;

      if (module === target || module?.endsWith(".hbs")) continue;

      if (module && REEXPORT.test(source)) {
        files.set(target, `export { default } from "${relativeTo(target, module)}";\n`);
        continue;
      }
    }

    files.set(target, rewriteSource(source, { origin: file, target, imports, modules }));
  }

  let manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  /** @type {Record<string, string>} */
  let ranges = {};

  for (let [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!BUILD_DEPENDENCY.test(dependency)) ranges[dependency] = String(range);
  }

  return { files, imports, ranges };
}

/**
 * Points the addon's imports at the new files. A component that imported its template as `layout`
 * gets it by co-location now, so the import and the property go.
 *
 * @param {string} source
 * @param {{ origin: string, target: string, imports: Record<string, string>, modules: Map<string, string> }} context
 * @returns {string}
 */
function rewriteSource(source, { origin, target, imports, modules }) {
  /**
   * @param {string} specifier
   * @returns {string | undefined} the new file of an import of the addon
   */
  let movedTo = (specifier) => {
    if (imports[specifier]) return imports[specifier];
    if (!specifier.startsWith(".")) return;

    return modules.get(
      withoutExtension(posix.normalize(posix.join(posix.dirname(origin), specifier))),
    );
  };

  /** @type {string[]} */
  let layouts = [];
  let output = source.replace(TEMPLATE_IMPORT, (line, local, _quote, specifier) => {
    if (!movedTo(specifier)?.endsWith(".hbs")) return line;

    layouts.push(local);
    return "";
  });

  for (let local of layouts) {
    output = output.replace(new RegExp(`^\\s*layout(\\s*:\\s*${local})?\\s*,?\\s*\\n`, "m"), "");
  }

  return output.replace(SPECIFIER, (match, before, quote, specifier) => {
    let moved = movedTo(specifier);

    return moved ? `${before}${quote}${relativeTo(target, moved)}${quote}` : match;
  });
}

/**
 * @param {string} from the importing file
 * @param {string} to the imported file
 * @returns {string} a relative specifier without the extension
 */
function relativeTo(from, to) {
  let path = posix.relative(posix.dirname(from), withoutExtension(to));

  return path.startsWith(".") ? path : `./${path}`;
}

/**
 * Moves a v1 addon with no v2 release into the app, as ember-cli merged it:
 * its modules go to the app paths that the resolver looks up, and its templates next to their components.
 *
 * @param {Project} project
 * @param {string} name
 * @returns {import('#types.js').Stage | undefined} undefined when the addon is not only code that the app can hold
 */
export function inlineV1Stage(project, name) {
  let installed = join(project.directory, "node_modules", name);

  if (!existsSync(join(installed, "package.json"))) return;

  let directory = realpathSync(installed);
  let plan = planInline(name, directory);

  if (!plan) return;

  let { files, imports, ranges } = plan;

  return inlineStage({
    name,
    label: `Move ${name}, a v1 addon with no v2 release, into the app`,
    files: Object.fromEntries(files),
    imports,
    ranges,
    note: `${name} is a v1 addon with no v2 release, so its code is in the app now, where ember-cli merged it.`,
  });
}
