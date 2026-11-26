import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";

import { parseProgram, propertyName, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { transform as replaceEmberGlobals } from "#stages/ember-globals/transform.js";
import { parse as parseVersion } from "#stages/ember-source/index.js";
import { stripTypes } from "#strip-types.js";
import { contentForPages } from "./content-for.js";
import { includedImports, vendorFiles } from "./included.js";
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
 * @property {boolean} contentFor the addon adds HTML to the app's pages with a `contentFor` hook
 * @property {boolean} included the addon imports vendor files with an `included` hook
 */

/**
 * The build hooks whose work the inline stage does once: `contentFor` adds HTML, which goes into the app's HTML files.
 */
const INLINED_HOOKS = new Set(["contentFor"]);

/**
 * The index.js properties that ember-cli calls. The others are functions that the hooks call,
 * which run with the `included` hook.
 */
const EMBER_CLI_HOOKS = new Set([
  "blueprintsPath",
  "buildError",
  "cacheKeyForTree",
  "config",
  "contentFor",
  "dependencies",
  "import",
  "importTransforms",
  "included",
  "includedCommands",
  "init",
  "lintTree",
  "options",
  "outputReady",
  "postBuild",
  "postprocessTree",
  "preBuild",
  "preprocessTree",
  "serverMiddleware",
  "setupPreprocessorRegistry",
  "shouldIncludeChildAddon",
  "testemMiddleware",
  "treeFor",
  "treeForAddon",
  "treeForAddonStyles",
  "treeForAddonTemplates",
  "treeForAddonTestSupport",
  "treeForApp",
  "treeForPublic",
  "treeForStyles",
  "treeForTemplates",
  "treeForTestSupport",
  "treeForVendor",
  "module.exports",
  "...",
]);

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
 * Only a re-export makes the addon module visible at the app path. An app module that imports it, such as
 * the instance-initializer of ember-href-to, keeps its own code.
 *
 * @param {string} name the addon
 * @param {string} source a module of the addon's `app/` tree
 * @returns {string | undefined} the addon module that the source re-exports, such as `components/x-select`
 */
function reexportOf(name, source) {
  let escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let from = `["']${escaped}/([^"']+)["']`;
  let direct = new RegExp(`export\\s*(?:\\{[^}]*\\}|\\*)\\s*from\\s*${from}`).exec(source);

  if (direct) return direct[1];

  let imported = new RegExp(
    `^\\s*import\\s+([\\w$]+)\\s+from\\s*${from};?\\s*export\\s+default\\s+\\1;?\\s*$`,
  ).exec(source);

  return imported?.[2];
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

    let specifier = reexportOf(name, read(file) ?? "");

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
   * A template goes where its component went: `templates/components/x.hbs`, or `components/x/template.hbs` of a pod.
   */
  for (let [file, target] of placed) {
    let pod = /^addon\/components\/(.+)\/template\.hbs$/.exec(file)?.[1];

    if (!file.startsWith("addon/templates/components/") && !pod) continue;

    let module = pod
      ? `${pod}/component`
      : withoutExtension(file.slice("addon/templates/components/".length));
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
 * @param {[number, number, number]} [emberVersion] the app's ember-source, which answers the version checks of ember-compatibility-helpers
 * @returns {Plan | undefined}
 */
export function planInline(name, directory, taken, emberVersion) {
  let hooks = buildHooks(directory);
  let included = hooks.includes("included");

  /**
   * An `included` hook runs once, with an app that records its imports, so the functions that it calls can stay.
   */
  if (
    hooks.some(
      (hook) =>
        !INLINED_HOOKS.has(hook) && hook !== "included" && (EMBER_CLI_HOOKS.has(hook) || !included),
    )
  ) {
    return;
  }
  if (existsSync(join(directory, "addon", "styles"))) return;

  let contentFor = hooks.includes("contentFor");

  let sources = globSync("{addon,app,test-support,addon-test-support}/**/*", {
    cwd: directory,
    exclude: (entry) => entry === "node_modules",
  })
    .map((file) => file.split("\\").join("/"))
    .filter((file) => CODE.test(file))
    .sort();

  if (sources.length === 0 && !contentFor) return;

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

    /**
     * The ember-globals stage ran before the code came into the app, so the code gets the same change here.
     */
    if (target.endsWith(".hbs")) {
      rewritten = withHasBlockHelpers(rewritten);
    } else {
      if (/\bfrom\s*["']ember["']/.test(rewritten)) {
        rewritten = replaceEmberGlobals(rewritten, target).code;
      }

      if (emberVersion) rewritten = withoutCompatibilityHelpers(rewritten, emberVersion);

      rewritten = withDeprecationOwner(rewritten, target, name, addonVersion(directory));
    }

    files.set(target, rewritten);
  }

  let manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  /** @type {Record<string, string>} */
  let ranges = {};

  /**
   * Ember 4 removed the global acceptance test helpers, so a module that registers one cannot run.
   * Nothing imports it, because the tests called the helper as a global.
   */
  for (let [target, source] of files) {
    if (
      /\bimport\s*\{[^}]*\bregister(Async)?Helper\b[^}]*\}\s*from\s*["']@ember\/test["']/.test(
        source,
      )
    ) {
      files.delete(target);
    }
  }

  let used = importedPackages(Array.from(files.values()));

  for (let [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (BUILD_DEPENDENCY.test(dependency)) continue;

    /**
     * A dependency that the code does not import stays out, unless it is an addon whose components templates can use.
     */
    if (!used.has(dependency) && !hasAppTree(directory, dependency)) continue;

    ranges[dependency] = String(range);
  }

  return { files, imports, ranges, contentFor, included };
}

/**
 * @param {string} directory
 * @returns {string}
 */
function addonVersion(directory) {
  return String(
    JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version ?? "0.0.0",
  );
}

/**
 * Ember 4 asserts that each `deprecate()` names its package in `for`, and the versions in `since`.
 * Old addon code did not, so the inlined code names the addon.
 *
 * @param {string} source
 * @param {string} file
 * @param {string} name the addon
 * @param {string} version the addon's version
 * @returns {string}
 */
export function withDeprecationOwner(source, file, name, version) {
  if (!/\bdeprecate\b/.test(source)) return source;

  let program = parseProgram(source, file);

  if (!program) return source;

  let local = program.body
    .filter(
      (/** @type {Node} */ node) =>
        node.type === "ImportDeclaration" && node.source.value === "@ember/debug",
    )
    .flatMap((/** @type {Node} */ node) => node.specifiers)
    .find((/** @type {Node} */ specifier) => specifier.imported?.name === "deprecate")?.local.name;

  if (!local) return source;

  let edits = new Edits(source);

  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee?.name !== local) return;

    let options = node.arguments[2];

    if (options?.type !== "ObjectExpression") return;

    let keys = new Set(
      options.properties.map((/** @type {Node} */ property) => property.key?.name),
    );
    /** @type {string[]} */
    let add = [];

    if (!keys.has("for")) add.push(`for: '${name}'`);
    if (!keys.has("since")) add.push(`since: { available: '${version}', enabled: '${version}' }`);

    if (add.length === 0) return;

    let last = options.properties.at(-1);

    let lineStart = last ? source.lastIndexOf("\n", last.start - 1) + 1 : 0;
    let indent = last ? (/^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "") : "";
    let multiline = last && source.slice(options.start, options.end).includes("\n");

    if (last && multiline)
      edits.insert(last.end, add.map((entry) => `,\n${indent}${entry}`).join(""));
    else if (last) edits.insert(last.end, `, ${add.join(", ")}`);
    else edits.replace(options, `{ ${add.join(", ")} }`);
  });

  return edits.size > 0 ? edits.apply() : source;
}

const COMPATIBILITY_IMPORT =
  /^import\s*\{([^}]*)\}\s*from\s*["']ember-compatibility-helpers["'];?[ \t]*\n/m;

/**
 * ember-compatibility-helpers is a babel plugin that answers `gte('3.22.0')` and `lte()` at build time,
 * so the code gets the answers for the app's ember-source.
 *
 * @param {string} source
 * @param {[number, number, number]} emberVersion
 * @returns {string} the source as it was, when it uses other helpers of the package
 */
export function withoutCompatibilityHelpers(source, emberVersion) {
  let match = COMPATIBILITY_IMPORT.exec(source);

  if (!match) return source;

  let names = match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (names.some((name) => name !== "gte" && name !== "lte")) return source;

  let compare = (/** @type {string} */ version) => {
    let other = version.split(".").map(Number);

    for (let index = 0; index < 3; index++) {
      let difference = emberVersion[index] - (other[index] ?? 0);

      if (difference !== 0) return difference;
    }

    return 0;
  };
  let output = source.replace(COMPATIBILITY_IMPORT, "");

  for (let name of names) {
    output = output.replace(
      new RegExp(`\\b${name}\\(\\s*["']([\\d.]+)["']\\s*\\)`, "g"),
      (_, version) => String(name === "gte" ? compare(version) >= 0 : compare(version) <= 0),
    );
  }

  return new RegExp(`\\b(${names.join("|")})\\(`).test(output) ? source : output;
}

/**
 * @param {string[]} sources
 * @returns {Set<string>} the packages that the sources import
 */
function importedPackages(sources) {
  /** @type {Set<string>} */
  let packages = new Set();

  for (let source of sources) {
    for (let match of source.matchAll(SPECIFIER)) {
      let specifier = match[3];

      if (specifier.startsWith(".")) continue;

      let parts = specifier.split("/");

      packages.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
    }
  }

  return packages;
}

/**
 * @param {string} directory the addon
 * @param {string} dependency
 * @returns {boolean} the dependency is an addon with modules that the app resolves by name, such as components
 */
function hasAppTree(directory, dependency) {
  let installed = dependencyDirectory(directory, dependency);

  if (!installed) return false;

  let manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));

  return existsSync(join(installed, "app")) || Boolean(manifest["ember-addon"]?.["app-js"]);
}

/**
 * @param {string} directory an installed package
 * @param {string} dependency
 * @returns {string | undefined} where the package's dependency is installed, next to it in a pnpm store or above it
 */
export function dependencyDirectory(directory, dependency) {
  let depth = dependency.startsWith("@") ? 2 : 1;
  let parent = join(directory, ...Array.from({ length: depth }, () => ".."));

  for (let candidate of [join(directory, "node_modules", dependency), join(parent, dependency)]) {
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
  }
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

    /**
     * `@layout(layout)` of @ember-decorators/component set the template, as the colocated one does now.
     */
    let decorator = new RegExp(`^[ \\t]*@(\\w+)\\(${local}\\)[ \\t]*\\n`, "m").exec(output);

    if (decorator) {
      output = output.replace(decorator[0], "");
      output = output.replace(
        new RegExp(
          `^import \\{\\s*layout(?: as ${decorator[1]})?\\s*\\} from ["']@ember-decorators/component["'];?\\n`,
          "m",
        ),
        "",
      );
    }
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
 * @param {Project} project
 * @returns {boolean} the app compiles TypeScript
 */
function usesTypeScript(project) {
  return project.has("tsconfig.json") || Boolean(project.dependency("typescript"));
}

/**
 * An app without TypeScript gets the addon's TypeScript modules as JavaScript.
 *
 * @param {Map<string, string>} files
 * @param {Record<string, string>} imports
 * @returns {{ files: Map<string, string>, imports: Record<string, string> }}
 */
function asJavaScript(files, imports) {
  /** @type {Map<string, string>} */
  let renamed = new Map();
  /** @type {Map<string, string>} */
  let output = new Map();

  for (let [file, source] of files) {
    let stripped = /\.(ts|gts)$/.test(file) ? stripTypes(source, file) : undefined;
    let target =
      stripped === undefined ? file : file.replace(/\.ts$/, ".js").replace(/\.gts$/, ".gjs");

    if (target !== file) renamed.set(file, target);

    output.set(target, stripped ?? source);
  }

  let newImports = Object.fromEntries(
    Object.entries(imports).map(([specifier, file]) => [specifier, renamed.get(file) ?? file]),
  );

  return { files: output, imports: newImports };
}

/**
 * Moves a v1 addon with no v2 release into the app, as ember-cli merged it:
 * its modules go to the app paths that the resolver looks up, and its templates next to their components.
 *
 * @param {Project} project
 * @param {string} name
 * @param {string} [from] where the addon is installed, when it is a dependency of another addon and not of the app
 * @returns {(import('#types.js').Stage & { dependencies: Record<string, string>, directory: string }) | undefined} undefined when the addon is not only code that the app can hold
 */
export function inlineV1Stage(project, name, from) {
  let installed = from ?? join(project.directory, "node_modules", name);

  if (!existsSync(join(installed, "package.json"))) return;

  let directory = realpathSync(installed);
  let plan = planInline(
    name,
    directory,
    (file) => {
      let base = file.replace(CODE, "");

      return file.endsWith(".hbs")
        ? project.has(file)
        : [".js", ".ts", ".gjs", ".gts"].some((extension) => project.has(base + extension));
    },
    parseVersion(project.dependency("ember-source")),
  );

  if (!plan) return;

  let { files, imports, ranges, contentFor, included } = plan;

  if (!usesTypeScript(project)) ({ files, imports } = asJavaScript(files, imports));

  /**
   * A hook that needs ember-cli, such as one that calls `this.addons`, keeps the addon a v1 addon.
   */
  if (contentFor && !contentForPages(project, directory)) return;

  let vendor = included ? includedImports(project, directory) : [];

  if (!vendor || (vendor.length > 0 && !vendorFiles(project, directory, vendor))) return;

  let vendorImports = vendor;

  /**
   * @param {Project} target
   * @returns {Record<string, string> | undefined}
   */
  let generated = (target) => {
    let pages = contentFor ? contentForPages(target, directory) : {};
    let copied = vendorImports.length > 0 ? vendorFiles(target, directory, vendorImports) : {};

    return pages && copied ? Object.assign({}, pages, copied) : undefined;
  };

  let stage = inlineStage({
    name,
    label: `Move ${name}, a v1 addon with no v2 release, into the app`,
    files: Object.fromEntries(files),
    generated: contentFor || vendor.length > 0 ? generated : undefined,
    imports,
    ranges,
    note: contentFor
      ? `${name} is a v1 addon with no v2 release, so its code is in the app now, where ember-cli merged it, and the HTML that its contentFor hook added is in the app's HTML files.`
      : `${name} is a v1 addon with no v2 release, so its code is in the app now, where ember-cli merged it.`,
  });

  return Object.assign(stage, { dependencies: ranges, directory });
}
