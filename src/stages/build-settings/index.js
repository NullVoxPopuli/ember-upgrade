import { copyFileSync, mkdirSync, rmSync } from "node:fs";
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

const MSW_WORKER = "msw/mockServiceWorker.js";

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
 * @typedef {object} Settings
 * @property {string[]} babelPlugins plugins from `babel.plugins` that babel.config needs
 * @property {string[]} otherBabel parts of the `babel` option that the stage cannot move
 * @property {string | undefined} autoImport the source of the `autoImport` option
 * @property {{ statement: Node, file: string, type: string }[]} imports the `app.import()` calls
 * @property {boolean} msw the build copies the MSW service worker into the public files
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
  };

  walk(program, (node, parent) => {
    if (node.type === "NewExpression" && node.arguments[1]?.type === "ObjectExpression") {
      for (let property of node.arguments[1].properties) {
        let name = propertyName(property);

        if (name === "autoImport") settings.autoImport = source.slice(property.start, property.end);

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

      settings.imports.push({
        statement: parent,
        file: String(node.arguments[0].value),
        type: type?.value.value === "test" ? "test" : "app",
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
        settings.msw),
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
      let worker = join(project.directory, "node_modules", MSW_WORKER);

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

    if (settings.msw) removeCompatBuildOptions(project, ["extraPublicTrees"]);

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

    removeBuildOptions(project, ["babel", "autoImport"]);

    return todo;
  },
};
