import { rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { parseProgram, propertyName, walk } from "#ast.js";
import { buildFile, removeProperty } from "#config-files.js";
import { Edits } from "#edits.js";
import {
  dependencyNames,
  editPackageJson,
  removeDependency,
  setDependency,
} from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";
import { Project } from "#project.js";

import {
  classBodies,
  compositions,
  definitionsOnly,
  definitions,
  importPath,
  importPaths,
  reindent,
  resolveSass,
  topLevel,
  unwrapGlobal,
  wrapBareGlobal,
} from "./styles.js";
import { rewriteTemplate } from "./templates.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('#types.js').Finding} Finding */

const NEW = "ember-scoped-css";
const FALLBACK = "3.5.2";
const GUIDE = "https://github.com/BlueCutOfficial/css-modules-to-scoped-css";
const DOCS = "https://github.com/auditboard/ember-scoped-css#usage";

/**
 * The app, or one in-repo addon or engine. ember-css-modules reads each one on its own.
 *
 * @typedef {object} Unit
 * @property {string} root the folder of its package.json
 * @property {string} source `app`, or `lib/<name>/addon`
 * @property {string} entry the global stylesheet that ember-cli-sass or ember-cli builds
 * @property {string} [config] the file with its `cssModules` options
 * @property {string} name the first part of its module paths, such as `app-name/styles/x`
 */

/**
 * Everything the stage changes, so that `check` can report it without a change.
 *
 * @typedef {object} Plan
 * @property {Map<string, string>} writes
 * @property {string[]} removes
 * @property {Map<string, string[]>} leftovers what a human must change, by title
 */

/**
 * @param {import('#project.js').Project} project
 * @returns {string[]}
 */
function oldPackages(project) {
  return dependencyNames(project.packageJson).filter(
    (name) => name === "ember-css-modules" || name.startsWith("ember-css-modules-"),
  );
}

/**
 * Moves an app from ember-css-modules to ember-scoped-css.
 * ember-vite-codemod refuses an app with ember-css-modules.
 *
 * Each module becomes a `<style scoped>` block at the top of its template.
 * Inline blocks work for pods, for in-repo addons, and for Sass with `lang="scss"`,
 * where co-located files do not.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ember-css-modules",
  label: "Move from ember-css-modules to ember-scoped-css",

  detect(project) {
    return Boolean(project.dependency("ember-css-modules"));
  },

  async check(project) {
    return { blockers: [], todo: findings(plan(project)) };
  },

  async run(project) {
    let result = plan(project);

    for (let [file, contents] of result.writes) project.write(file, contents);
    for (let file of result.removes) rmSync(join(project.directory, file), { force: true });

    let range = `^${published(NEW)?.version ?? FALLBACK}`;
    let names = oldPackages(project);

    editPackageJson(project, (pkg) => {
      for (let name of names) removeDependency(pkg, name);
      setDependency(pkg, NEW, range);
    });

    for (let file of project.files(["lib/*/package.json"])) {
      let addon = new Project(join(project.directory, dirname(file)));

      if (!oldPackages(addon).length) continue;

      editPackageJson(addon, (pkg) => {
        for (let name of oldPackages(addon)) removeDependency(pkg, name);
      });
    }

    recordProgress(project, {
      id: "ember-css-modules",
      status: "removed",
      note:
        "The styles of each component and route are in a <style scoped> block at the top of its template. " +
        "The ember-scoped-css stage runs after the vite stage and adds the Vite and Babel plugins. " +
        "Until then, the classic build does not apply these styles. " +
        "If ember-template-lint forbids <style>, allow it with the no-forbidden-elements rule. " +
        "Element selectors such as `p` are now scoped to the component, and ids are global. " +
        "Each `composes` is a copy of the declarations it named.",
      links: [GUIDE, DOCS],
    });

    for (let finding of findings(result)) {
      recordProgress(project, {
        id: `ember-css-modules: ${finding.title}`,
        status: "todo",
        note: `${finding.action} Files: ${(finding.where ?? []).join(", ")}`,
        links: [GUIDE],
      });
    }

    return findings(result);
  },
};

/**
 * @type {Record<string, string>}
 */
const ACTIONS = {
  "Templates that ember-upgrade cannot change":
    "Use `class`. For a class from another file, pass it in with `scoped-class` from the component that defines it.",
  "Style modules without a template":
    "Move the styles into the template that uses them, in a <style scoped> block.",
  "Styles that `composes` a class it cannot copy":
    "Copy the declarations, or add the class in the template. ember-scoped-css has no `composes`.",
  "Styles with `@value`": "Use CSS custom properties.",
  "JavaScript that reads ember-css-modules":
    "ember-scoped-css scopes only classes in templates. Move the class to the template, or use `scopedClass` in a .gjs file.",
  "Tests that use local-class": "Use `class` with the class name.",
  "Global modules to import": "Import these files from the global stylesheet.",
  "Sass variables from another module":
    "Import the file that defines each variable at the top of the <style scoped> block.",
  "Shared Sass files that also output CSS":
    "Each <style scoped> block imports these files for their variables and mixins, so their CSS repeats in each component. Move the CSS to another file.",
};

/**
 * @param {Plan} result
 * @returns {Finding[]}
 */
function findings(result) {
  /** @type {Finding[]} */
  let list = [];

  for (let [title, where] of result.leftovers) {
    list.push({ title, where, action: ACTIONS[title] });
  }

  return list;
}

/**
 * @param {import('#project.js').Project} project
 * @returns {Unit[]}
 */
function units(project) {
  /** @type {Unit[]} */
  let list = [
    {
      root: "",
      source: "app",
      entry: "app/styles/app",
      config: buildFile(project),
      name: String(project.packageJson.name),
    },
  ];

  for (let file of project.files(["lib/*/package.json"])) {
    let root = dirname(file);

    if (!project.has(join(root, "addon"))) continue;

    list.push({
      root,
      source: join(root, "addon"),
      entry: join(root, "addon/styles/addon"),
      config: project.has(join(root, "index.js")) ? join(root, "index.js") : undefined,
      name: String(JSON.parse(project.read(file)).name ?? basename(root)),
    });
  }

  return list;
}

/**
 * @typedef {object} ModuleOptions
 * @property {string[]} headerModules
 * @property {string | undefined} extension
 * @property {string[]} includePaths
 */

/**
 * Reads the `cssModules` and `sassOptions` options of the app or addon.
 *
 * @param {import('#project.js').Project} project
 * @param {string | undefined} file
 * @returns {ModuleOptions}
 */
function moduleOptions(project, file) {
  /** @type {ModuleOptions} */
  let options = { headerModules: [], extension: undefined, includePaths: [] };
  let program = file && parseProgram(project.read(file), file);

  /**
   * @param {Node} node
   * @returns {string[]}
   */
  let strings = (node) =>
    node.type === "ArrayExpression"
      ? node.elements
          .filter((/** @type {Node} */ e) => e?.type === "Literal" && typeof e.value === "string")
          .map((/** @type {Node} */ e) => e.value)
      : [];

  walk(program, (node) => {
    let name = propertyName(node);

    if (name === "headerModules") options.headerModules = strings(node.value);
    if (name === "includePaths") options.includePaths = strings(node.value);
    if (name === "extension" && node.value.type === "Literal") options.extension = node.value.value;
  });

  return options;
}

/**
 * Where the template of a module is.
 * ember-css-modules pairs `x/styles.css` with `x/template.hbs` (pods),
 * `components/x.css` with `components/x.hbs` (co-located),
 * and `styles/x.css` with `templates/x.hbs` (classic).
 *
 * @param {import('#project.js').Project} project
 * @param {Unit} unit
 * @param {string} file
 * @param {string} extension
 * @returns {string | undefined}
 */
function templateFor(project, unit, file, extension) {
  let folder = dirname(file);
  let name = basename(file).slice(0, -(extension.length + 1));
  let styles = join(unit.source, "styles");
  /** @type {string[]} */
  let candidates = [];

  if (name === "styles") candidates.push(join(folder, "template.hbs"));

  candidates.push(join(folder, `${name}.hbs`));

  if (file.startsWith(`${styles}/`)) {
    let path = file.slice(styles.length + 1, -(extension.length + 1));

    candidates.push(join(unit.source, "templates", `${path}.hbs`));

    if (path.startsWith("components/")) {
      candidates.push(join(unit.source, `${path}.hbs`), join(unit.source, path, "template.hbs"));
    }
  }

  return candidates.find((candidate) => project.has(candidate));
}

/**
 * @param {import('#project.js').Project} project
 * @returns {Plan}
 */
export function plan(project) {
  /** @type {Plan} */
  let result = { writes: new Map(), removes: [], leftovers: new Map() };
  let app = moduleOptions(project, buildFile(project));
  let has = (/** @type {string} */ file) => project.has(file);
  let read = (/** @type {string} */ file) => result.writes.get(file) ?? project.read(file);

  /**
   * @param {string} title
   * @param {string} where
   */
  let leftover = (title, where) => {
    let list = result.leftovers.get(title) ?? [];

    if (!list.includes(where)) result.leftovers.set(title, list.concat(where));
  };

  /** @type {Set<string>} */
  let templates = new Set();
  /** @type {Set<string>} */
  let removed = new Set();
  let sass = Boolean(project.dependency("ember-css-modules-sass"));

  let all = units(project);
  let sources = new Map(all.map((unit) => [unit.name, unit.source]));

  for (let unit of all) {
    let own = unit.config === buildFile(project) ? app : moduleOptions(project, unit.config);
    let extension = own.extension ?? app.extension ?? (sass ? "scss" : "css");
    let scss = /s[ac]ss$/.test(extension);
    let loadPaths = app.includePaths.map((path) => path.replace(/\/$/, "")).concat("");
    let headers = own.headerModules
      .map((name) => join(unit.source, name.split("/").slice(1).join("/")))
      .map((path) => resolveSass(has, path, [""]) ?? `${path}.${extension}`)
      .filter(has);

    /**
     * Each module was a part of one Sass file, after the header modules.
     * So the variables and mixins of the headers were visible in each module.
     */
    /** @type {Shared[]} */
    let shared = [];
    /** @type {string[]} */
    let globals = [];

    /**
     * @param {string} file
     * @returns {boolean} true when a module can need the file
     */
    let share = (file) => {
      let uses = usesOf(has, read, file, loadPaths, new Set());

      if (uses.length === 0 || shared.some((item) => item.file === file)) return false;

      shared.push({ file, uses, outputs: !definitionsOnly(has, read, file, loadPaths) });
      return true;
    };

    for (let header of headers) {
      if (!scss) {
        globals.push(header);
        continue;
      }

      if (definitions(read(header)).length > 0 && share(header)) continue;

      globals.push(header);

      for (let statement of topLevel(read(header), true)) {
        for (let spec of importPaths(statement.prelude) ?? []) {
          let file = resolveSass(has, spec, [dirname(header)].concat(loadPaths));

          if (file) share(file);
        }
      }
    }

    /**
     * Sass reads a block from the folder of its template, without the load paths of ember-cli-sass.
     * So the imports in shared files must be relative too.
     */
    for (let item of shared) {
      let source = read(item.file);
      let output = relativeImports(has, source, item.file, loadPaths);

      if (output !== source) result.writes.set(item.file, output);
    }

    let modules = project
      .files([`${unit.source}/**/*.${extension}`])
      .filter((file) => !basename(file).startsWith("_") && !headers.includes(file));

    for (let file of modules) {
      let template = templateFor(project, unit, file, extension);

      if (!template) {
        if (file.startsWith(join(unit.source, "styles/"))) globals.push(file);
        else leftover("Style modules without a template", file);
        continue;
      }

      let css = moduleCss(project, file, {
        scss,
        extension,
        loadPaths,
        shared,
        folder: dirname(template),
        sources,
        leftover,
      });
      let rewritten = rewriteTemplate(read(template));
      let lang = scss ? ` lang="${extension.endsWith("sass") ? "sass" : "scss"}"` : "";

      for (let item of rewritten.leftovers) {
        leftover("Templates that ember-upgrade cannot change", `${template}: ${item}`);
      }

      result.writes.set(
        template,
        `<style scoped${lang}>\n${css.trim()}\n</style>\n\n${rewritten.output}`,
      );
      templates.add(template);
      result.removes.push(file);
      removed.add(file);
    }

    /**
     * The global stylesheet takes the header modules and the other files in `styles/`.
     * Their classes were scoped too, unless they were in `:global()`.
     */
    let entry = `${unit.entry}.${extension}`;

    for (let file of globals) {
      let source = read(file);
      let output = unwrapGlobal(source);

      if (output !== source) result.writes.set(file, output);
    }

    let imports = globals.filter((file) => file !== entry);

    if (imports.length > 0 && scss) {
      let lines = imports.map((file) => `@import '${importPath(dirname(entry), file)}';`);
      let existing = has(entry) ? read(entry) : "";

      result.writes.set(entry, lines.join("\n") + "\n" + existing);
    } else if (imports.length > 0) {
      for (let file of imports) leftover("Global modules to import", `${entry}: ${file}`);
    }

    for (let file of project.files([`${unit.source}/**/*.hbs`])) {
      if (templates.has(file)) continue;

      let source = read(file);

      if (!source.includes("local-class")) continue;

      let rewritten = rewriteTemplate(source);

      if (rewritten.output !== source) result.writes.set(file, rewritten.output);

      for (let item of rewritten.leftovers) {
        leftover("Templates that ember-upgrade cannot change", `${file}: ${item}`);
      }
    }

    for (let file of project.files([`${unit.source}/**/*.{js,ts}`])) {
      let source = read(file);

      if (!/ember-css-modules|['"]\.\/styles['"]/.test(source)) continue;

      let output = removeStyleImports(source, file, (where) =>
        leftover("JavaScript that reads ember-css-modules", where),
      );

      if (output !== source) result.writes.set(file, output);
    }

    if (unit.config && unit.config !== buildFile(project)) {
      let source = read(unit.config);
      let output = removeOption(source, unit.config, "cssModules");

      if (output !== source) result.writes.set(unit.config, output);
    }
  }

  let build = buildFile(project);

  if (build) {
    let source = read(build);
    let output = removeOption(source, build, "cssModules");

    if (output !== source) result.writes.set(build, output);
  }

  for (let file of project.files(["tests/**/*.{js,ts,gjs,gts}"])) {
    if (read(file).includes("local-class")) leftover("Tests that use local-class", file);
  }

  for (let file of removed) result.writes.delete(file);

  return result;
}

/**
 * The CSS of one module, ready for a `<style scoped>` block.
 *
 * @typedef {object} ModuleContext
 * @property {boolean} scss
 * @property {string} extension
 * @property {string[]} loadPaths
 * @property {Shared[]} shared the files with the variables and mixins of the header modules
 * @property {string} folder the folder of the template, which Sass resolves imports from
 * @property {Map<string, string>} sources the source folder of each package name
 * @property {(title: string, where: string) => void} leftover
 */

/**
 * @param {import('#project.js').Project} project
 * @param {string} file
 * @param {ModuleContext} context
 * @returns {string}
 */
export function moduleCss(project, file, context) {
  let { scss, extension, loadPaths, shared, folder, sources, leftover } = context;
  let has = (/** @type {string} */ path) => project.has(path);
  let source = project.read(file);
  let edits = new Edits(source);
  /** @type {Set<string>} */
  /** @type {Set<string>} */
  let imports = new Set();

  /**
   * Sass now reads the block from the folder of the template, without the load paths of ember-cli-sass.
   *
   * @param {Statement} statement
   */
  let moveImport = (statement) => {
    let paths = importPaths(statement.prelude);

    if (!paths) return;

    let resolved = paths.map((spec) => resolveSass(has, spec, [dirname(file)].concat(loadPaths)));

    if (!resolved.every(Boolean)) return;

    for (let path of resolved) imports.add(/** @type {string} */ (path));

    edits.replace(statement, "");
  };

  if (scss) {
    for (let statement of topLevel(source, true)) {
      moveImport(statement);
    }
  }

  for (let composition of compositions(source)) {
    let from = composition.from;

    if (from === "global") {
      leftover("Styles that `composes` a class it cannot copy", `${file}: ${composition.names}`);
      continue;
    }

    let other = from ? modulePath(from, file, sources) : file;

    if (other && !has(other) && has(`${other}.${extension}`)) other = `${other}.${extension}`;

    if (!other || !has(other)) {
      leftover("Styles that `composes` a class it cannot copy", `${file}: ${from}`);
      continue;
    }

    let otherSource = project.read(other);
    let bodies = composition.names.map((name) => classBodies(otherSource, name, scss));

    if (bodies.some((list) => list.length === 0 || (!scss && list.some((b) => b.includes("{"))))) {
      leftover(
        "Styles that `composes` a class it cannot copy",
        `${file}: ${composition.names.join(" ")}`,
      );
      continue;
    }

    if (from && scss) {
      for (let statement of topLevel(otherSource, true)) {
        for (let spec of importPaths(statement.prelude) ?? []) {
          let path = resolveSass(has, spec, [dirname(other)].concat(loadPaths));

          if (path) imports.add(path);
        }
      }
    }

    let lineStart = source.lastIndexOf("\n", composition.start - 1) + 1;
    let indent = source.slice(lineStart, composition.start);
    let declarations = bodies
      .flat()
      .map((body) => reindent(body, indent))
      .join(`\n${indent}`);

    edits.replace(composition, declarations);
  }

  if (/(^|\n)\s*@value\s/.test(source)) leftover("Styles with `@value`", file);

  let css = wrapBareGlobal(edits.size > 0 ? edits.apply() : source);
  /** @type {string[]} */
  let files = [];

  /**
   * The files that the module imports used the header modules too.
   */
  let used = css;
  let seen = new Set();

  for (let path of imports)
    used += importedText(has, (f) => project.read(f), path, loadPaths, seen);

  for (let item of shared) {
    if (!item.uses.some((use) => use.test(used))) continue;

    files.push(item.file);

    if (item.outputs) leftover("Shared Sass files that also output CSS", item.file);
  }

  for (let path of imports) if (!files.includes(path)) files.push(path);

  if (scss) {
    for (let path of files)
      used += importedText(has, (f) => project.read(f), path, loadPaths, seen);

    for (let name of undefinedVariables(used)) {
      leftover("Sass variables from another module", `${file}: $${name}`);
    }
  }

  if (!scss || files.length === 0) return css;

  let lines = files.map((path) => `@import '${importPath(folder, path)}';`);

  return lines.join("\n") + "\n\n" + css.replace(/^\s*\n/, "");
}

/** @typedef {import('./styles.js').Statement} Statement */

/**
 * A file that each module could see before, because it came from a header module.
 *
 * @typedef {object} Shared
 * @property {string} file
 * @property {RegExp[]} uses patterns that match where a module uses one of its definitions
 * @property {boolean} outputs the file has rules too, not only definitions
 */

/**
 * Variables that the text uses but does not define.
 * ember-css-modules-sass compiled all modules as one file, so a module could use a variable of a module before it.
 *
 * @param {string} text a module and the files it imports
 * @returns {string[]}
 */
export function undefinedVariables(text) {
  let code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  let defined = new Set(Array.from(code.matchAll(/\$([\w-]+)\s*:/g), (match) => match[1]));

  for (let line of code.match(/@(each|for|mixin|function|include)\b.*$/gm) ?? []) {
    for (let match of line.matchAll(/\$([\w-]+)/g)) defined.add(match[1]);
  }

  /** @type {Set<string>} */
  let missing = new Set();

  for (let match of code.matchAll(/\$([\w-]+)/g)) {
    if (!defined.has(match[1])) missing.add(match[1]);
  }

  return Array.from(missing);
}

/**
 * The text of a Sass file and of the files it imports.
 *
 * @param {(file: string) => boolean} has
 * @param {(file: string) => string} read
 * @param {string} file
 * @param {string[]} loadPaths
 * @param {Set<string>} seen
 * @returns {string}
 */
function importedText(has, read, file, loadPaths, seen) {
  if (seen.has(file)) return "";

  seen.add(file);

  let source = read(file);
  let text = source;

  for (let statement of topLevel(source, true)) {
    for (let spec of importPaths(statement.prelude) ?? []) {
      let path = resolveSass(has, spec, [dirname(file)].concat(loadPaths));

      if (path) text += importedText(has, read, path, loadPaths, seen);
    }
  }

  return text;
}

/**
 * Changes each `@import` that needs a load path to a path relative to the file.
 *
 * @param {(file: string) => boolean} has
 * @param {string} source
 * @param {string} file
 * @param {string[]} loadPaths
 * @returns {string}
 */
function relativeImports(has, source, file, loadPaths) {
  let edits = new Edits(source);

  for (let statement of topLevel(source, true)) {
    let paths = importPaths(statement.prelude);

    if (!paths) continue;

    let changed = paths.map((spec) => {
      if (resolveSass(has, spec, [dirname(file)])) return spec;

      let path = resolveSass(has, spec, loadPaths);

      return path ? importPath(dirname(file), path) : spec;
    });

    if (changed.some((spec, index) => spec !== paths[index])) {
      edits.replace(statement, `@import ${changed.map((spec) => `'${spec}'`).join(", ")};`);
    }
  }

  return edits.size > 0 ? edits.apply() : source;
}

/**
 * The definitions of a Sass file and of the files it imports.
 *
 * @param {(file: string) => boolean} has
 * @param {(file: string) => string} read
 * @param {string} file
 * @param {string[]} loadPaths
 * @param {Set<string>} seen
 * @returns {RegExp[]}
 */
function usesOf(has, read, file, loadPaths, seen) {
  if (seen.has(file)) return [];

  seen.add(file);

  let source = read(file);
  let uses = definitions(source);

  for (let statement of topLevel(source, true)) {
    for (let spec of importPaths(statement.prelude) ?? []) {
      let path = resolveSass(has, spec, [dirname(file)].concat(loadPaths));

      if (path) uses = uses.concat(usesOf(has, read, path, loadPaths, seen));
    }
  }

  return uses;
}

/**
 * ember-css-modules reads `from` as a relative path, or as a module path such as `addon-name/components/x/styles`.
 *
 * @param {string} from
 * @param {string} file the module that has the `composes`
 * @param {Map<string, string>} sources
 * @returns {string | undefined}
 */
function modulePath(from, file, sources) {
  if (from.startsWith(".")) return join(dirname(file), from);

  let slash = from.indexOf("/");
  let source = sources.get(from.slice(0, slash));

  return source && join(source, from.slice(slash + 1));
}

/**
 * Removes `import styles from './styles'` where the styles are only passed on, as in `@layout(template, styles)`.
 * ember-scoped-css has no JavaScript object of class names.
 *
 * @param {string} source
 * @param {string} file
 * @param {(where: string) => void} leftover
 * @returns {string}
 */
export function removeStyleImports(source, file, leftover) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);

  for (let node of /** @type {Node[]} */ (program.body)) {
    if (node.type !== "ImportDeclaration") continue;

    let value = node.source.value;

    if (value === "ember-css-modules" || value.startsWith("ember-css-modules/")) {
      leftover(`${file}: import from "${value}"`);
      continue;
    }

    if (!/^\.\/styles(\.\w+)?$/.test(value)) continue;

    let local = node.specifiers[0]?.local?.name;
    /** @type {{ node: Node, call: Node }[]} */
    let uses = [];
    let other = false;

    walk(program, (child, parent) => {
      if (
        child.type !== "Identifier" ||
        child.name !== local ||
        parent?.type === "ImportDefaultSpecifier"
      ) {
        return;
      }

      if (parent?.type === "CallExpression" && parent.arguments.includes(child)) {
        uses.push({ node: child, call: parent });
      } else {
        other = true;
      }
    });

    if (other) {
      leftover(`${file}: ${local}`);
      continue;
    }

    edits.removeLine(node);

    for (let { node: argument, call } of uses) {
      let index = call.arguments.indexOf(argument);
      let previous = call.arguments[index - 1];
      let next = call.arguments[index + 1];

      if (previous) edits.replace({ start: previous.end, end: argument.end }, "");
      else if (next) edits.replace({ start: argument.start, end: next.start }, "");
      else edits.replace(argument, "");
    }
  }

  return edits.size > 0 ? edits.apply() : source;
}

/**
 * Removes a property from each object literal in the file, such as `cssModules` in `module.exports`.
 *
 * @param {string} source
 * @param {string} file
 * @param {string} name
 * @returns {string}
 */
export function removeOption(source, file, name) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);

  walk(program, (node) => {
    if (node.type === "Property" && propertyName(node) === name) removeProperty(edits, node);
  });

  return edits.size > 0 ? edits.apply() : source;
}
