import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, posix } from "node:path";

import { parseProgram, propertyName, walk } from "#ast.js";
import { buildFile, removeBuildOptions, removeCompatBuildOptions } from "#config-files.js";
import { Edits } from "#edits.js";
import { editPackageJson } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#types.js').Finding} Finding */

const BABEL_CONFIGS = ["babel.config.mjs", "babel.config.cjs", "babel.config.js"];

/**
 * Vite does not run ember-auto-import, so its babel plugin has nothing to do.
 */
const DROPPED_BABEL_PLUGINS = new Set(["ember-auto-import/babel-plugin"]);

/**
 * Options of `new EmberApp()` that ember.nvp stops on. `babel` can hold only plugins that Vite does not need,
 * and `ifa` inlined the asset map of ember-cli-ifa, which Vite does not write.
 */
const BLOCKING_OPTIONS = new Set(["babel", "ifa"]);

const MSW_WORKER = "msw/mockServiceWorker.js";
const OUTPUT_CSS = "app/styles/output-paths.js";
const STYLE_EXTENSIONS = [".scss", ".sass", ".less", ".css"];

/**
 * @param {string} source
 * @param {Node | undefined} node
 * @returns {string | undefined} the module that a babel plugin entry names: `'x'` or `require.resolve('x')`
 */
function pluginModule(source, node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;

  if (
    node?.type === "CallExpression" &&
    source.slice(node.callee.start, node.callee.end) === "require.resolve" &&
    node.arguments[0]?.type === "Literal"
  ) {
    return String(node.arguments[0].value);
  }
}

/**
 * @param {Node | undefined} node an object
 * @param {string} name
 * @returns {Node | undefined} the value of the property
 */
function propertyValue(node, name) {
  return node?.properties?.find((/** @type {Node} */ property) => propertyName(property) === name)
    ?.value;
}

/**
 * The main stylesheet, `app`, is the one that Vite builds from the app's imports.
 *
 * @param {Node} outputPaths
 * @returns {{ name: string, path: string }[]} the other entries of `outputPaths.app.css`
 */
function outputCss(outputPaths) {
  let css = propertyValue(propertyValue(outputPaths, "app"), "css");

  return (css?.properties ?? [])
    .map((/** @type {Node} */ property) => ({
      name: propertyName(property),
      path: property.value?.type === "Literal" ? property.value.value : undefined,
    }))
    .filter(
      (/** @type {{ name: string | undefined, path: unknown }} */ entry) =>
        entry.name && entry.name !== "app" && typeof entry.path === "string",
    );
}

/**
 * @typedef {object} Settings
 * @property {string[]} babelPlugins plugins from `babel.plugins` that babel.config needs
 * @property {string[]} otherBabel parts of the `babel` option that the stage cannot move
 * @property {string | undefined} autoImport the source of the `autoImport` option
 * @property {{ statement: Node, file: string, type: string, amd?: string }[]} imports the `app.import()` calls, with the module name of an `amd` transformation
 * @property {boolean} msw the build copies the MSW service worker into the public files
 * @property {boolean} outputPaths ember-cli-build has the `outputPaths` option
 * @property {{ name: string, path: string }[]} outputCss the extra CSS files of `outputPaths.app.css`, such as `themes/forest` at `/assets/theme-forest.css`
 * @property {boolean} emptyPublicTrees compatBuild has `extraPublicTrees: []`, which adds nothing
 * @property {string[]} blockingOptions the options of `new EmberApp()` that ember.nvp stops on, and that the stage removes
 */

/**
 * @param {string} source ember-cli-build
 * @param {string} file
 * @returns {Settings | undefined}
 */
export function readSettings(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  /** @type {Settings} */
  let settings = {
    babelPlugins: [],
    otherBabel: [],
    autoImport: undefined,
    imports: [],
    msw: source.includes(MSW_WORKER),
    outputPaths: false,
    outputCss: [],
    emptyPublicTrees: false,
    blockingOptions: [],
  };

  walk(program, (node, parent) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "compatBuild" &&
      node.arguments[2]?.type === "ObjectExpression"
    ) {
      for (let property of node.arguments[2].properties) {
        if (
          propertyName(property) === "extraPublicTrees" &&
          property.value.type === "ArrayExpression" &&
          property.value.elements.length === 0
        ) {
          settings.emptyPublicTrees = true;
        }
      }
    }

    if (node.type === "NewExpression" && node.arguments[1]?.type === "ObjectExpression") {
      for (let property of node.arguments[1].properties) {
        let name = propertyName(property);

        if (name && BLOCKING_OPTIONS.has(name)) settings.blockingOptions.push(name);

        if (name === "autoImport") settings.autoImport = source.slice(property.start, property.end);
        if (name === "outputPaths") {
          settings.outputPaths = true;
          settings.outputCss = outputCss(property.value);
        }

        if (name !== "babel") continue;

        for (let option of property.value.properties ?? []) {
          if (propertyName(option) !== "plugins" || option.value.type !== "ArrayExpression") {
            settings.otherBabel.push(source.slice(option.start, option.end));
            continue;
          }

          for (let element of option.value.elements) {
            let name = pluginModule(source, element);

            if (name === undefined)
              settings.otherBabel.push(source.slice(element.start, element.end));
            else if (!DROPPED_BABEL_PLUGINS.has(name)) settings.babelPlugins.push(name);
          }
        }
      }
    }

    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "app" &&
      node.callee.property.name === "import" &&
      node.arguments[0]?.type === "Literal" &&
      parent?.type === "ExpressionStatement"
    ) {
      let options = node.arguments[1];
      let type = options?.properties?.find((/** @type {Node} */ p) => propertyName(p) === "type");

      let using = options?.properties?.find((/** @type {Node} */ p) => propertyName(p) === "using");
      let amd = (using?.value?.elements ?? [])
        .map((/** @type {Node} */ element) => {
          let fields = new Map(
            (element.properties ?? []).map((/** @type {Node} */ p) => [
              propertyName(p),
              p.value?.value,
            ]),
          );

          return fields.get("transformation") === "amd" ? fields.get("as") : undefined;
        })
        .find((/** @type {unknown} */ name) => typeof name === "string");

      settings.imports.push({
        statement: parent,
        file: String(node.arguments[0].value),
        type: type?.value.value === "test" ? "test" : "app",
        amd,
      });
    }
  });

  return settings;
}

/**
 * Adds plugins to the `plugins` array of a babel config, before `...babelCompatSupport()` when it is there.
 *
 * @param {string} source
 * @param {string} file
 * @param {string[]} names
 * @returns {string | undefined} undefined when the config has no `plugins` array
 */
export function addBabelPlugins(source, file, names) {
  let program = parseProgram(source, file);

  if (!program) return;

  /** @type {Node | undefined} */
  let plugins;

  walk(program, (node) => {
    if (!plugins && propertyName(node) === "plugins" && node.value.type === "ArrayExpression") {
      plugins = node.value;
    }
  });

  if (!plugins) return;

  let missing = names.filter(
    (name) => !source.includes(`'${name}'`) && !source.includes(`"${name}"`),
  );

  if (missing.length === 0) return source;

  let elements = /** @type {Node[]} */ (plugins.elements);
  let spread = elements.find((element) => element?.type === "SpreadElement");
  let edits = new Edits(source);
  let lineStart = source.lastIndexOf("\n", (spread ?? elements[0] ?? plugins).start - 1) + 1;
  let indent = source.slice(lineStart).match(/^[ \t]*/)?.[0] ?? "    ";
  let text = missing.map((name) => `'${name}',\n${indent}`).join("");

  if (spread) {
    edits.insert(spread.start, text);
  } else if (elements.length > 0) {
    let last = elements[elements.length - 1];

    edits.insert(
      last.end,
      `,\n${indent}${missing.map((name) => `'${name}'`).join(`,\n${indent}`)}`,
    );
  } else {
    edits.replace(plugins, `[${missing.map((name) => `'${name}'`).join(", ")}]`);
  }

  return edits.apply();
}

/**
 * Removes the statement with its lines, and one blank line after it when a blank line is also before it.
 *
 * @param {Edits} edits
 * @param {{ start: number, end: number }} statement
 */
function removeStatement(edits, statement) {
  let source = edits.source;
  let start = source.lastIndexOf("\n", statement.start - 1) + 1;
  let end = source.indexOf("\n", statement.end) + 1 || source.length;

  if (
    source.slice(start, statement.start).trim() !== "" ||
    source.slice(statement.end, end).trim() !== ""
  ) {
    edits.removeLine(statement);
    return;
  }

  let blankBefore = source.slice(0, start).endsWith("\n\n");
  let blankAfter = source.slice(end).match(/^[ \t]*\n/);

  if (blankBefore && blankAfter) end += blankAfter[0].length;

  edits.replace({ start, end }, "");
}

/**
 * @param {Project} project
 * @param {string} from a module name, such as `dom-purify`
 * @param {string} to such as `dompurify/dist/purify.js`
 */
function renameImports(project, from, to) {
  for (let file of project.files(["{app,tests}/**/*.{js,ts,gjs,gts}"])) {
    let source = project.read(file);
    let output = source.split(`'${from}'`).join(`'${to}'`).split(`"${from}"`).join(`"${to}"`);

    if (output !== source) project.write(file, output);
  }
}

/**
 * @param {Project} project
 * @param {string} file
 * @param {string} line
 */
function prependImport(project, file, line) {
  let source = project.read(file);

  if (source.includes(line)) return;

  let program = parseProgram(source, file);
  let imports = (program?.body ?? []).filter(
    (/** @type {Node} */ node) => node.type === "ImportDeclaration",
  );
  let edits = new Edits(source);

  if (imports.length > 0) edits.insert(imports[imports.length - 1].end, `\n${line}`);
  else edits.insert(0, `${line}\n`);

  project.write(file, edits.apply());
}

/**
 * @param {Project} project
 * @param {string[]} candidates
 */
function firstOf(project, candidates) {
  return candidates.find((file) => project.has(file));
}

/**
 * @param {Project} project
 * @param {{ name: string, path: string }[]} entries
 * @returns {string | undefined} a module with the URL of each stylesheet, by its old path
 */
function outputStylesheets(project, entries) {
  /** @type {string[]} */
  let imports = [];
  /** @type {string[]} */
  let urls = [];

  for (let [index, entry] of entries.entries()) {
    let file = STYLE_EXTENSIONS.map((extension) => `app/styles/${entry.name}${extension}`).find(
      (candidate) => project.has(candidate),
    );

    if (!file) continue;

    imports.push(`import stylesheet${index} from "./${file.slice("app/styles/".length)}?url";\n`);
    urls.push(`  ${JSON.stringify(entry.path)}: stylesheet${index},\n`);
  }

  if (imports.length === 0) return;

  return (
    imports.join("") +
    "\n/**\n * The URL of each stylesheet that ember-cli-build built as its own file, by the path that it had.\n */\n" +
    `export default {\n${urls.join("")}};\n`
  );
}

/**
 * Moves the settings of ember-cli-build that a Vite build has another place for.
 * ember.nvp builds with Vite alone, so it refuses an ember-cli-build that still has them.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "build-settings",
  label: "Move the ember-cli-build settings that Vite has another place for",

  detect(project) {
    let file = buildFile(project);

    if (!file || !project.dependency("@embroider/vite")) return false;

    let settings = readSettings(project.read(file), file);

    return Boolean(
      settings &&
      (settings.babelPlugins.length > 0 ||
        settings.otherBabel.length > 0 ||
        settings.autoImport ||
        settings.imports.length > 0 ||
        settings.msw ||
        settings.outputPaths ||
        settings.emptyPublicTrees ||
        settings.blockingOptions.length > 0),
    );
  },

  async check(project) {
    /** @type {Finding[]} */
    let blockers = [];
    let file = /** @type {string} */ (buildFile(project));
    let settings = readSettings(project.read(file), file);

    if (!settings) {
      blockers.push({ title: `${file} does not parse`, where: [file], action: "Fix the syntax." });
    } else if (settings.babelPlugins.length > 0 && !firstOf(project, BABEL_CONFIGS)) {
      blockers.push({
        title: "No babel.config file for the babel plugins of ember-cli-build",
        where: [file],
        action: "Run the vite stage first.",
      });
    }

    return { blockers, todo: [] };
  },

  async run(project) {
    let file = /** @type {string} */ (buildFile(project));
    let source = project.read(file);
    let settings = /** @type {Settings} */ (readSettings(source, file));
    /** @type {Finding[]} */
    let todo = [];
    let edits = new Edits(source);

    for (let entry of settings.imports) {
      let target = entry.type === "test" ? "tests" : "app";
      let entryFile = firstOf(
        project,
        entry.type === "test"
          ? ["tests/test-helper.js", "tests/test-helper.ts"]
          : ["app/app.js", "app/app.ts"],
      );

      /**
       * A file of an npm package: the app imports it from the package, as Vite resolves it.
       * An `amd` transformation named the module, so imports of that name now name the file.
       */
      if (entry.file.startsWith("node_modules/") && entryFile && project.has(entry.file)) {
        let path = entry.file.slice("node_modules/".length);

        if (entry.amd) {
          renameImports(project, entry.amd, path);
        } else {
          prependImport(project, entryFile, `import '${path}';`);
        }

        removeStatement(edits, entry.statement);
        continue;
      }

      if (!entry.file.startsWith("vendor/") || !entryFile || !project.has(entry.file)) {
        todo.push({
          title: "app.import() that the stage cannot move",
          where: [`${file}: ${source.slice(entry.statement.start, entry.statement.end)}`],
          action: "Import the file from the app's code, or install it from npm.",
        });
        continue;
      }

      let moved = posix.join(target, "vendor", posix.relative("vendor", entry.file));

      mkdirSync(join(project.directory, dirname(moved)), { recursive: true });
      copyFileSync(join(project.directory, entry.file), join(project.directory, moved));
      rmSync(join(project.directory, entry.file));
      prependImport(
        project,
        entryFile,
        `import './${posix.relative(posix.dirname(entryFile), moved)}';`,
      );
      removeStatement(edits, entry.statement);
    }

    /**
     * The service worker of MSW is a public file. MSW copies it to the `workerDirectory`
     * on each install, so the build does not need to.
     */
    if (settings.msw) {
      /**
       * msw maps the path through its package.json `exports`, as require.resolve in ember-cli-build did.
       */
      let worker = createRequire(join(project.directory, "package.json")).resolve(MSW_WORKER);

      mkdirSync(join(project.directory, "public"), { recursive: true });
      copyFileSync(worker, join(project.directory, "public", basename(MSW_WORKER)));
      editPackageJson(project, (pkg) => {
        pkg.msw = Object.assign({}, pkg.msw, { workerDirectory: ["public"] });
      });

      /**
       * The statements that build extraPublicTrees, such as the funnel of the worker.
       * walk() visits parents first, so a statement inside a removed one is skipped.
       */
      /** @type {Node[]} */
      let removed = [];

      walk(parseProgram(source, file), (node, parent) => {
        if (removed.some((outer) => outer.start <= node.start && node.end <= outer.end)) return;

        if (
          parent?.type === "BlockStatement" &&
          node.type !== "ReturnStatement" &&
          /\bextraPublicTrees\b/.test(source.slice(node.start, node.end))
        ) {
          removed.push(node);
        }
      });

      /**
       * Statements next to each other go as one range, so their blank lines do not add up.
       */
      /** @type {{ start: number, end: number }[]} */
      let ranges = [];

      for (let node of removed.sort((a, b) => a.start - b.start)) {
        let last = ranges[ranges.length - 1];

        if (last && source.slice(last.end, node.start).trim() === "") last.end = node.end;
        else ranges.push({ start: node.start, end: node.end });
      }

      for (let range of ranges) removeStatement(edits, range);

      recordProgress(project, {
        id: "build-settings: MSW worker",
        status: "moved",
        note:
          "public/mockServiceWorker.js is the MSW service worker, which ember-cli-build copied in development builds. " +
          'package.json "msw.workerDirectory" makes MSW update it on each install. It is now in production builds too.',
        links: ["https://mswjs.io/docs/best-practices/managing-the-worker"],
      });
    }

    if (edits.size > 0) project.write(file, edits.apply());

    if (settings.msw || settings.emptyPublicTrees) {
      removeCompatBuildOptions(project, ["extraPublicTrees"]);
    }

    if (settings.babelPlugins.length > 0) {
      let babel = /** @type {string} */ (firstOf(project, BABEL_CONFIGS));
      let output = addBabelPlugins(project.read(babel), babel, settings.babelPlugins);

      if (output === undefined) {
        todo.push({
          title: "Babel plugins to add to the babel config",
          where: [babel],
          action: `Add ${settings.babelPlugins.join(", ")} to \`plugins\`.`,
        });
      } else {
        project.write(babel, output);
      }
    }

    if (settings.otherBabel.length > 0) {
      recordProgress(project, {
        id: "build-settings: babel",
        status: "removed",
        note:
          "ember-cli-build had these babel settings, which a Vite build reads from the babel config instead: " +
          `${settings.otherBabel.join("; ")}. Add the ones that the app still needs to the babel config.`,
      });
    }

    if (settings.autoImport) {
      recordProgress(project, {
        id: "build-settings: autoImport",
        status: "removed",
        note:
          "ember-cli-build had ember-auto-import settings, which Vite does not run. " +
          "Webpack externals and devtool have Vite equivalents: build.rollupOptions.external and build.sourcemap.",
        links: ["https://vite.dev/config/build-options"],
      });
    }

    let stylesheets = outputStylesheets(project, settings.outputCss);

    if (stylesheets) {
      project.write(OUTPUT_CSS, stylesheets);
      recordProgress(project, {
        id: "build-settings: outputPaths",
        status: "moved",
        note:
          `ember-cli-build built these stylesheets as their own files: ${settings.outputCss.map((entry) => entry.path).join(", ")}. ` +
          `${OUTPUT_CSS} maps each of those paths to the URL that Vite builds. Load the stylesheets through it.`,
        links: ["https://vite.dev/guide/assets#explicit-url-imports"],
      });
    }

    /**
     * Vite minifies, fingerprints, and writes source maps with its own settings,
     * and names its output files.
     */
    removeBuildOptions(project, [
      "babel",
      "autoImport",
      "fingerprint",
      "ifa",
      "minifyJS",
      "minifyCSS",
      "outputPaths",
      "sourcemaps",
    ]);

    return todo;
  },
};
