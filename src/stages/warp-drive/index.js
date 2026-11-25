import { parseProgram, SKIP, walk } from "#ast.js";
import { importMap } from "#codemods/imports.js";
import { Edits } from "#edits.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('#project.js').Project} Project */

const APPS = ["app/app.js", "app/app.ts"];
const INSTALL = "@warp-drive/ember/install";
const BABEL_CONFIGS = ["babel.config.js", "babel.config.mjs", "babel.config.cjs"];
const STRING_UTILS = "@warp-drive/utilities/string";

/**
 * The inflector methods that WarpDrive's string utilities have, with the same arguments.
 */
const INFLECTIONS = new Set(["uncountable", "irregular", "plural", "singular"]);

const RELATIONSHIPS = new Set(["belongsTo", "hasMany"]);

const WORDS = new Set(["pluralize", "singularize"]);

const STORES = ["app/services/store.js", "app/services/store.ts"];

/**
 * A store service that only re-exports ember-data's store, as the app-tree stage writes it.
 */
const STORE_REEXPORT =
  /^\s*(export \* from ["']ember-data\/(app\/services\/)?store["'];?\s*)?export \{ default \} from ["']ember-data\/(app\/services\/)?store["'];?\s*$/;

/**
 * ember-data's store with the legacy request methods and the LegacyNetworkHandler set up on purpose.
 * Implicit, the same methods log warp-drive:deprecate-legacy-request-methods.
 */
export const LEGACY_STORE = `import { JSONAPICache } from "@warp-drive/json-api";
import { useLegacyStore } from "@warp-drive/legacy";

export default useLegacyStore({
  linksMode: false,
  legacyRequests: true,
  cache: JSONAPICache,
});
`;

/**
 * \`record.save()\` has no options in most apps. A \`save\` with arguments, such as a local storage helper, is not a record.
 */
const RECORD_SAVE = /\.save\(\s*\)/;

/**
 * @param {Project} project
 * @returns {string | undefined} the version range of WarpDrive in the app
 */
function warpDriveRange(project) {
  return project.dependency("@warp-drive/core") ?? project.dependency("ember-data");
}

/**
 * WarpDrive needs Ember's reactivity system from `@warp-drive/ember/install`. Before, `@ember-data/tracking` gave it.
 *
 * @param {string} source app/app.js or app/app.ts
 * @param {string} [file]
 * @returns {string | undefined} undefined when the app already imports it
 */
export function withInstall(source, file = "app/app.js") {
  if (source.includes(INSTALL)) return;

  let program = parseProgram(source, file);

  if (!program) return;

  let imports = program.body.filter(
    (/** @type {Node} */ node) => node.type === "ImportDeclaration",
  );
  let last = imports[imports.length - 1];
  let edits = new Edits(source);

  edits.insert(last ? last.end : 0, last ? `\nimport "${INSTALL}";` : `import "${INSTALL}";\n`);

  return edits.apply();
}

/**
 * Marks the deprecation of `@ember-data/tracking` as resolved, in the WarpDrive config of the babel config.
 *
 * @param {string} source
 * @param {string} file
 * @returns {string | undefined} undefined when there is no `setConfig(config, { ... })`, or it has deprecations
 */
export function withTrackingResolved(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  /** @type {Node | undefined} */
  let options;

  walk(program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "setConfig" &&
      node.arguments[1]?.type === "ObjectExpression"
    ) {
      options = node.arguments[1];
    }
  });

  if (!options || source.slice(options.start, options.end).includes("deprecations")) return;

  let last = options.properties[options.properties.length - 1];
  let property = "deprecations: { DEPRECATE_TRACKING_PACKAGE: false }";
  let edits = new Edits(source);

  if (!last) {
    edits.replace(options, `{ ${property} }`);
  } else {
    let lineStart = source.lastIndexOf("\n", last.start - 1) + 1;
    let indent = source.slice(lineStart, last.start);
    let comma = source.slice(last.end).match(/^\s*,/);
    let end = last.end + (comma ? comma[0].length : 0);

    edits.insert(
      end,
      indent.trim() === "" ? `${comma ? "" : ","}\n${indent}${property},` : `, ${property}`,
    );
  }

  return edits.apply();
}

/**
 * Moves `Inflector.inflector.uncountable(...)` and the other rules of ember-inflector to WarpDrive's string utilities,
 * which WarpDrive reads (warp-drive.ember-inflector).
 *
 * @param {string} source
 * @param {string} file
 * @returns {string | undefined}
 */
export function withStringUtils(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  let imports = importMap(program);
  /** @type {string | undefined} */
  let inflector;

  for (let [local, from] of imports) {
    if (from.module === "ember-inflector" && from.imported === "default") inflector = local;
  }

  if (!inflector) return;

  let edits = new Edits(source);
  /** @type {Set<string>} */
  let used = new Set();
  let otherUses = 0;

  let count = (/** @type {Node} */ node) => {
    if (node.type === "Identifier" && node.name === inflector) otherUses++;
  };

  walk(program, (node) => {
    let callee = node.type === "CallExpression" ? node.callee : undefined;
    let object = callee?.type === "MemberExpression" ? callee.object : undefined;

    if (
      object?.type === "MemberExpression" &&
      object.object.type === "Identifier" &&
      object.object.name === inflector &&
      object.property.name === "inflector" &&
      INFLECTIONS.has(callee.property.name)
    ) {
      used.add(callee.property.name);
      edits.replace(callee, callee.property.name);

      for (let argument of node.arguments) walk(argument, count);

      return SKIP;
    }

    count(node);
  });

  if (used.size === 0) return;

  let declaration = program.body.find(
    (/** @type {Node} */ node) =>
      node.type === "ImportDeclaration" &&
      node.source.value === "ember-inflector" &&
      node.specifiers.some((/** @type {Node} */ s) => s.type === "ImportDefaultSpecifier"),
  );
  let line = `import { ${Array.from(used).sort().join(", ")} } from "${STRING_UTILS}";`;

  /**
   * The import's own identifier is one use. The rewritten calls are not counted.
   */
  if (otherUses <= 1 && declaration.specifiers.length === 1) edits.replace(declaration, line);
  else edits.insert(declaration.end, `\n${line}`);

  return edits.apply();
}

/**
 * WarpDrive reads only its own inflection rules, so code that inflects with ember-inflector,
 * such as a Mirage server, would miss them. WarpDrive's `pluralize` and `singularize` take one word,
 * and ember-inflector's `pluralize` also takes a count first, so each call must have one argument.
 *
 * @param {string} source
 * @param {string} file
 * @returns {string | undefined}
 */
export function withWarpDriveInflection(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  let declaration = program.body.find(
    (/** @type {Node} */ node) =>
      node.type === "ImportDeclaration" &&
      node.source.value === "ember-inflector" &&
      node.specifiers.length > 0 &&
      node.specifiers.every(
        (/** @type {Node} */ s) =>
          s.type === "ImportSpecifier" && WORDS.has(s.imported.name ?? s.imported.value),
      ),
  );

  if (!declaration) return;

  let locals = new Set(declaration.specifiers.map((/** @type {Node} */ s) => s.local.name));
  let fits = true;

  walk(program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      locals.has(node.callee.name) &&
      node.arguments.length !== 1
    ) {
      fits = false;
    }
  });

  if (!fits) return;

  let edits = new Edits(source);
  let quote = source[declaration.source.start];

  edits.replace(declaration.source, `${quote}${STRING_UTILS}${quote}`);

  return edits.apply();
}

/**
 * @param {string} type
 * @returns {string}
 */
function dasherize(type) {
  return type.replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Writes the related type of each relationship in its normalized form (ember-data:deprecate-non-strict-types).
 *
 * @param {string} source a model
 * @param {string} file
 * @returns {string | undefined}
 */
export function withStrictTypes(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  let imports = importMap(program);
  let edits = new Edits(source);

  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return;

    let from = imports.get(node.callee.name);
    let type = node.arguments[0];

    if (
      !from ||
      !RELATIONSHIPS.has(from.imported) ||
      (from.module !== "@ember-data/model" && from.module !== "ember-data/model") ||
      type?.type !== "Literal" ||
      typeof type.value !== "string" ||
      dasherize(type.value) === type.value
    ) {
      return;
    }

    let quote = source[type.start];

    edits.replace(type, `${quote}${dasherize(type.value)}${quote}`);
  });

  return edits.size > 0 ? edits.apply() : undefined;
}

/**
 * @param {Project} project
 * @returns {Map<string, string>} the changed files
 */
function plan(project) {
  /** @type {Map<string, string>} */
  let changes = new Map();

  let app = APPS.find((file) => project.has(file));
  let installed = false;

  if (app) {
    let source = project.read(app);
    let output = withInstall(source, app);

    if (output) changes.set(app, output);

    installed = Boolean(output) || source.includes(INSTALL);
  }

  let babel = BABEL_CONFIGS.find((file) => project.has(file));

  /**
   * The install import resolves the deprecation, so the config marks it with the same change.
   */
  if (babel && app && changes.has(app)) {
    let output = withTrackingResolved(project.read(babel), babel);

    if (output) changes.set(babel, output);
  }

  /**
   * Unlike ember-data's store, the legacy store does not set up Ember's reactivity.
   * It needs the install import.
   */
  let store = STORES.find((file) => project.has(file));

  if (installed && store && STORE_REEXPORT.test(project.read(store))) {
    changes.set(store, LEGACY_STORE);
  }

  for (let file of project.files(["{app,mirage,tests}/**/*.{js,ts,gjs,gts}"])) {
    let source = project.read(file);
    let output;

    if (source.includes("ember-inflector")) {
      output = withStringUtils(source, file);
      output = withWarpDriveInflection(output ?? source, file) ?? output;
    }

    if (file.startsWith("app/models/")) output = withStrictTypes(output ?? source, file) ?? output;
    if (output) changes.set(file, output);
  }

  return changes;
}

/**
 * The setup and the code changes that WarpDrive 5 asks for in its deprecations.
 * It runs after ember-nvp, which writes app/app.js and the babel config.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "warp-drive",
  label:
    "Resolve the WarpDrive deprecations: reactivity, the legacy store, inflections and relationship types",

  detect(project) {
    return Boolean(warpDriveRange(project)) && plan(project).size > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let range = /** @type {string} */ (warpDriveRange(project));

    let changes = plan(project);

    for (let [file, output] of changes) project.write(file, output);

    editPackageJson(project, (pkg) => {
      let installs = APPS.some((file) => changes.get(file)?.includes(INSTALL));
      let legacy = STORES.some((file) => changes.get(file) === LEGACY_STORE);

      /**
       * The install import takes the place of @ember-data/tracking.
       */
      if (installs) {
        removeDependency(pkg, "@ember-data/tracking");
        setDependency(pkg, "@warp-drive/ember", range);
      }

      if (legacy) {
        setDependency(pkg, "@warp-drive/legacy", range);
        setDependency(pkg, "@warp-drive/json-api", range);
      }

      let strings = Array.from(changes.values()).some((output) => output.includes(STRING_UTILS));

      if (strings) setDependency(pkg, "@warp-drive/utilities", range);
    });

    let saves = project
      .files(["app/**/*.{js,ts,gjs,gts}"])
      .filter((file) => RECORD_SAVE.test(project.read(file)));

    if (saves.length > 0) {
      recordProgress(project, {
        id: "warp-drive: record.save",
        status: "todo",
        note:
          `record.save() logs warp-drive:deprecate-legacy-request-methods. These files call save(): ${saves.join(", ")}. ` +
          "For each record, call `store.request(saveRecord(record))`, with `saveRecord` from @warp-drive/legacy/compat/builders.",
        links: [
          "https://docs.warp-drive.io/api/@warp-drive/core/build-config/deprecations/variables/ENABLE_LEGACY_REQUEST_METHODS",
        ],
      });
    }

    return [];
  },
};
