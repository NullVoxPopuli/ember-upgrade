import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";

import { parseProgram, propertyName, walk } from "#ast.js";
import { inlineStage } from "./inline.js";

/** @typedef {import('#ast.js').Node} Node */
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
  let manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  let file = join(directory, manifest["ember-addon"]?.main ?? "index.js");

  if (!existsSync(file)) return [];

  let program = parseProgram(readFileSync(file, "utf8"), file);
  let dependencies = manifest.dependencies ?? {};
  /** @type {string[] | undefined} */
  let hooks;

  walk(program, (node) => {
    if (
      node.type !== "AssignmentExpression" ||
      node.left?.type !== "MemberExpression" ||
      node.left.object?.name !== "module"
    ) {
      return;
    }

    /**
     * An export that is not an object, such as `ManifestGenerator.extend({ ... })` (ember-engines), brings hooks of its own.
     */
    if (node.right?.type !== "ObjectExpression") {
      hooks = ["module.exports"];
      return;
    }

    hooks = [];

    for (let property of node.right.properties) {
      let name = propertyName(property);

      if (name === "included" && importsDependencies(property, dependencies)) continue;
      if (!name || !NAMING.has(name)) hooks.push(name ?? "...");
    }
  });

  return hooks ?? ["module.exports"];
}

/**
 * @param {Node | undefined} node
 * @returns {Node | undefined} the identifier that a member chain or call chain starts at
 */
function rootOf(node) {
  if (node?.type === "CallExpression") return rootOf(node.callee);
  if (node?.type === "MemberExpression") return rootOf(node.object);

  return node;
}

/**
 * @param {Node | undefined} node
 * @returns {string[]} the property names of a member chain, such as `_super`, `included`, `apply`
 */
function memberNames(node) {
  if (node?.type === "CallExpression") return memberNames(node.callee);
  if (node?.type !== "MemberExpression") return [];

  return memberNames(node.object).concat(String(node.property?.name));
}

/**
 * An `included` hook that only makes the addon's dependencies importable, which old addons did
 * with `app.import('node_modules/<dependency>/...')` (ember-autoresize and dom-ruler).
 * The app declares the addon's dependencies when the addon moves in, so Vite imports them.
 * The version checks and the `_super` call around them do nothing for the app's code.
 *
 * @param {Node} property the `included` property of the addon
 * @param {Record<string, string>} dependencies the addon's dependencies
 * @returns {boolean}
 */
export function importsDependencies(property, dependencies) {
  let body = (property.value ?? property).body?.body;

  if (!Array.isArray(body)) return false;

  /** @type {Set<string>} */
  let checkers = new Set();

  return body.every((/** @type {Node} */ statement) => {
    if (statement.type === "VariableDeclaration") {
      return statement.declarations.every((/** @type {Node} */ declarator) => {
        if (
          declarator.init?.type !== "NewExpression" ||
          declarator.init.callee?.name !== "VersionChecker"
        ) {
          return false;
        }

        checkers.add(declarator.id?.name);
        return true;
      });
    }

    let call = statement.type === "ExpressionStatement" ? statement.expression : undefined;

    if (call?.type !== "CallExpression") return false;

    let root = rootOf(call);
    let callee = call.callee;

    if (
      root?.type === "ThisExpression" &&
      callee?.type === "MemberExpression" &&
      callee.property?.name === "import"
    ) {
      return importsDependency(call, dependencies);
    }

    if (root?.type === "ThisExpression") return memberNames(callee).includes("_super");
    if (root?.type === "Identifier" && checkers.has(root.name)) return true;

    return (
      callee?.type === "MemberExpression" &&
      callee.property?.name === "import" &&
      importsDependency(call, dependencies)
    );
  });
}

/**
 * @param {Node} call an `app.import(...)` call
 * @param {Record<string, string>} dependencies
 * @returns {boolean} the call imports a file of one of the dependencies
 */
function importsDependency(call, dependencies) {
  let path = call.arguments?.[0]?.value;

  if (typeof path !== "string" || !path.startsWith("node_modules/")) return false;

  let parts = path.slice("node_modules/".length).split("/");
  let name = parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : String(parts[0]);

  return name in dependencies;
}

/**
 * ember-cli merged the addon's `app/` tree into the app, so only the modules that it re-exports
 * were visible to the resolver. Each of those goes to its `app/` path, a component template goes
 * next to its component, and every other module stays in the addon's own folder, app/addons/<addon>.
 * The app's own files win, as they did in ember-cli: an addon module at the path of an app file,
 * which the app often extends, also goes to app/addons/<addon>.
 *
 * @param {string} name the addon
 * @param {string[]} sources the addon's code files
 * @param {(file: string) => string | undefined} read
 * @param {(file: string) => boolean} taken the project has a module at the path, with any extension
 * @returns {Map<string, string>} each file of `addon/`, `test-support/`, and `addon-test-support/`, and where it goes
 */
export function placements(name, sources, read, taken) {
  /** @type {Map<string, string>} the module of the addon, such as `components/x-select`, and its app path */
  let reexported = new Map();

  for (let file of sources) {
    if (!file.startsWith("app/")) continue;

    let specifier = new RegExp(`from\\s*["']${name}/([^"']+)["']`).exec(read(file) ?? "")?.[1];

    if (specifier) reexported.set(specifier, withoutExtension(file));
  }

  /** @type {Map<string, string>} */
  let placed = new Map();

  for (let file of sources) {
    let extension = /\.\w+$/.exec(file)?.[0] ?? "";

    if (file.startsWith("test-support/")) {
      placed.set(file, `tests/${file.slice("test-support/".length)}`);
      continue;
    }

    if (file.startsWith("addon-test-support/")) {
      /**
       * Apps import these as `<addon>/test-support/...`, and many addons have an index.js there.
       */
      placed.set(file, `tests/helpers/${name}/${file.slice("addon-test-support/".length)}`);
      continue;
    }

    if (!file.startsWith("addon/")) continue;

    let module = withoutExtension(file.slice("addon/".length));
    let own = `app/addons/${name}/${module}${extension}`;
    let component = module.startsWith("templates/components/")
      ? `app/components/${module.slice("templates/components/".length)}${extension}`
      : undefined;
    let visible =
      component ?? (reexported.has(module) ? `${reexported.get(module)}${extension}` : undefined);

    placed.set(file, visible && !taken(visible) ? visible : own);
  }

  /**
   * A template goes where its component went.
   */
  for (let [file, target] of placed) {
    if (!file.startsWith("addon/templates/components/")) continue;

    let module = withoutExtension(file.slice("addon/templates/components/".length));
    let component = Array.from(placed).find(
      ([from]) => withoutExtension(from) === `addon/components/${module}`,
    )?.[1];

    if (component) placed.set(file, `${withoutExtension(component)}.hbs`);
    else if (target.startsWith("app/addons/")) placed.set(file, target);
  }

  return placed;
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
 * The app's own files win, as they did in ember-cli. An addon module at the path of an app file,
 * which the app often extends, goes to app/addons/<addon>, where the resolver does not look.
 *
 * @param {string} name
 * @param {string} directory where the addon is installed
 * @param {(file: string) => boolean} taken the project has a module at the path, with any extension
 * @returns {Plan | undefined}
 */
export function planInline(name, directory, taken) {
  if (buildHooks(directory).length > 0 || existsSync(join(directory, "addon", "styles"))) return;

  let sources = globSync("{addon,app,test-support,addon-test-support}/**/*", {
    cwd: directory,
    exclude: (entry) => entry === "node_modules",
  })
    .map((file) => file.split("\\").join("/"))
    .filter((file) => CODE.test(file))
    .sort();

  if (sources.length === 0) return;

  let placed = placements(
    name,
    sources,
    (file) => readFileSync(join(directory, file), "utf8"),
    taken,
  );
  /** @type {Map<string, string>} module of the addon, without the extension, to its new path */
  let modules = new Map();
  /** @type {Record<string, string>} */
  let imports = {};

  for (let [file, target] of placed) {
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

  /**
   * An import of a folder, such as `<addon>/test-support`, gets its index file.
   */
  for (let [specifier, target] of Object.entries(imports)) {
    if (specifier.endsWith("/index")) imports[specifier.slice(0, -"/index".length)] ??= target;
  }

  /** @type {Map<string, string>} */
  let files = new Map();

  for (let file of sources) {
    let target = placed.get(file) ?? (file.startsWith("app/") ? file : undefined);

    if (!target || (file.startsWith("app/") && taken(target))) continue;

    let source = readFileSync(join(directory, file), "utf8");

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

    let rewritten = rewriteSource(source, { origin: file, target, imports, modules });

    files.set(target, target.endsWith(".hbs") ? withHasBlockHelpers(rewritten) : rewritten);
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
 * Ember 4 removed the `hasBlock` and `hasBlockParams` properties, which old addon templates still read.
 * The helpers replace them, with parentheses where the property was an argument.
 *
 * @param {string} template
 * @returns {string}
 */
export function withHasBlockHelpers(template) {
  return template
    .replace(
      /\{\{(~?)\s*hasBlock(Params)?\s*(~?)\}\}/g,
      (_, before, params, after) =>
        `{{${before}${params ? "has-block-params" : "has-block"}${after}}}`,
    )
    .replace(/(?<![\w.@-])hasBlock(Params)?(?![\w-])/g, (_, params) =>
      params ? "(has-block-params)" : "(has-block)",
    );
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
  let plan = planInline(name, directory, (file) => {
    let base = file.replace(CODE, "");

    return file.endsWith(".hbs")
      ? project.has(file)
      : [".js", ".ts", ".gjs", ".gts"].some((extension) => project.has(base + extension));
  });

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
