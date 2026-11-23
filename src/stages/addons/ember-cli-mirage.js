import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { parseProgram, propertyName, walk, SKIP } from "#ast.js";
import { removeBuildOptions } from "#config-files.js";
import { Edits } from "#edits.js";
import { modulePrefix } from "#module-prefix.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";
import { Project } from "#project.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('#types.js').Finding} Finding */

const OLD = "ember-cli-mirage";
const NEW = "ember-mirage";
const NEW_FALLBACK = "0.4.3";
const MIRAGE = "miragejs";
const MIRAGE_FALLBACK = "0.1.48";
const MACROS = "@embroider/macros";
const MACROS_FALLBACK = "1.16.0";

const MIGRATION = "https://github.com/bgantzler/ember-mirage/blob/main/docs/migration.md";
const ENVIRONMENT = "config/environment.js";
/**
 * The app and its tests reach mirage/ through package.json `imports`, like `#app/*` in ember.nvp.
 * mirage/ is not in app/, because an app can use mirage in tests only.
 */
const IMPORT_KEY = "#mirage/*";
const IMPORT_TARGET = "./mirage/*";

/**
 * The app, its tests, in-repo addons and engines, and the mirage folder.
 */
const SOURCES = [
  "{app,addon,addon-test-support,tests,src}/**/*.{js,ts,gjs,gts}",
  "lib/*/{addon,app,addon-test-support}/**/*.{js,ts,gjs,gts}",
  "mirage/**/*.{js,ts}",
];

/**
 * The folders that ember-cli-mirage read at runtime, with the key of each in the server config.
 * Scenarios are not here: mirage runs only `scenarios/default`.
 */
const KINDS = [
  { folder: "factories", key: "factories" },
  { folder: "fixtures", key: "fixtures" },
  { folder: "models", key: "models" },
  { folder: "serializers", key: "serializers" },
  { folder: "identity-managers", key: "identityManagers" },
];

/**
 * The runtime exports of miragejs.
 * ember-cli-mirage re-exported all of them.
 */
const MIRAGE_EXPORTS = new Set([
  "association",
  "trait",
  "Model",
  "Collection",
  "Serializer",
  "ActiveModelSerializer",
  "JSONAPISerializer",
  "RestSerializer",
  "hasMany",
  "belongsTo",
  "createServer",
  "Server",
  "Factory",
  "IdentityManager",
  "Response",
  "PretenderInterceptor",
]);

/**
 * The server config that the stage writes calls these itself.
 */
const DISCOVERY = new Set(["discoverEmberDataModels", "applyEmberDataSerializers"]);

/**
 * TS nodes that hold values. All other TS nodes are types, and Babel removes them.
 */
const TS_VALUES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSParameterProperty",
  "TSExportAssignment",
  "TSEnumDeclaration",
]);

const RESERVED = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(
    " ",
  ),
);

/**
 * Moves from ember-cli-mirage to ember-mirage, with the steps of its migration guide.
 * ember-mirage finds nothing by itself, so the stage writes the imports that
 * ember-cli-mirage did at runtime: models, factories, serializers, the server config.
 * ember-vite-codemod refuses an app with ember-cli-mirage.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: OLD,
  label: `Move from ${OLD} to ${NEW}`,

  detect(project) {
    return Boolean(project.dependency(OLD));
  },

  async check(project) {
    let result = plan(project);

    return { blockers: result.blockers, todo: result.todo };
  },

  async run(project) {
    let result = plan(project);

    if (result.blockers.length > 0) {
      throw new Error(result.blockers.map((b) => b.title).join("\n"));
    }

    for (let [file, contents] of result.writes) {
      mkdirSync(dirname(join(project.directory, file)), { recursive: true });
      project.write(file, contents);
    }

    editPackageJson(project, (pkg) => {
      removeDependency(pkg, OLD);
      setDependency(pkg, NEW, `^${published(NEW)?.version ?? NEW_FALLBACK}`);

      if (!project.dependency(MIRAGE)) {
        setDependency(pkg, MIRAGE, `^${published(MIRAGE)?.version ?? MIRAGE_FALLBACK}`);
      }

      if (result.addInflector)
        setDependency(
          pkg,
          "ember-inflector",
          `^${lockedVersion(project, "ember-inflector") ?? published("ember-inflector")?.version ?? "4.0.2"}`,
        );

      if (!project.dependency(MACROS)) {
        setDependency(pkg, MACROS, `^${published(MACROS)?.version ?? MACROS_FALLBACK}`);
      }

      pkg.imports ??= {};
      pkg.imports[IMPORT_KEY] = IMPORT_TARGET;
    });

    /**
     * In-repo addons and engines list the host's addons. They resolve from the host.
     */
    for (let file of project.files(["lib/*/package.json"])) {
      let addon = new Project(join(project.directory, dirname(file)));

      if (addon.dependency(OLD)) editPackageJson(addon, (pkg) => removeDependency(pkg, OLD));
    }

    removeBuildOptions(project, [OLD]);

    recordProgress(project, {
      id: OLD,
      status: "replaced",
      note:
        `${OLD} is replaced by ${NEW}. mirage/ stays next to app/ and tests/, ` +
        `and the app and the tests import it as #mirage/... (package.json "imports"). ` +
        "mirage/servers/default makes the server, with explicit imports in place of the runtime discovery. " +
        "The mirage models for the ember-data models are generated files now: change them when a model changes. " +
        "app/initializers/mirage starts mirage in development builds only, and reads ENV['ember-cli-mirage'] as before.",
      links: [MIGRATION, "https://mainmatter.com/blog/2026/07/14/ember-mirage/"],
    });

    for (let item of result.todo) {
      recordProgress(project, {
        id: `${OLD}: ${item.title}`,
        status: "todo",
        note: [item.action, item.where?.join(", ")].filter(Boolean).join(" Where: "),
        links: [MIGRATION],
      });
    }

    return result.todo;
  },
};

/**
 * @typedef {object} Plan
 * @property {Finding[]} blockers
 * @property {Finding[]} todo
 * @property {Map<string, string>} writes by path
 * @property {boolean} addInflector ember-inflector becomes a dependency
 */

/**
 * Works out every change without making one, so that `check` and `run` agree.
 *
 * @param {import('#project.js').Project} project
 * @returns {Plan}
 */
export function plan(project) {
  /** @type {Plan} */
  let result = { blockers: [], todo: [], writes: new Map(), addInflector: false };
  let configFile = ["mirage/config.js", "mirage/config.ts"].find((file) => project.has(file));
  let environment = project.has(ENVIRONMENT) ? project.read(ENVIRONMENT) : "";

  for (let file of ["ember-cli-build.js", ENVIRONMENT]) {
    if (
      project.has(file) &&
      /['"]?ember-cli-mirage['"]?\s*:\s*\{[^}]*\bdirectory\b/.test(project.read(file))
    ) {
      result.blockers.push({
        title: "The mirage folder is not mirage/",
        where: [file],
        action: `Move the folder to mirage/, and remove the directory option. Then run again.`,
      });
    }
  }

  if (!configFile) {
    result.blockers.push({
      title: "No mirage/config.js or mirage/config.ts",
      action: `Follow ${MIGRATION} by hand.`,
    });
  }

  /** @type {Record<string, string> | undefined} */
  let imports = /** @type {any} */ (project.packageJson).imports;
  let existingImport = imports?.[IMPORT_KEY];

  if (existingImport && existingImport !== IMPORT_TARGET) {
    result.blockers.push({
      title: `package.json maps ${IMPORT_KEY} to something other than ${IMPORT_TARGET}`,
      where: ["package.json"],
    });
  }

  if (result.blockers.length > 0 || !configFile) return result;

  let ext = configFile.endsWith(".ts") ? "ts" : "js";
  let configSource = project.read(configFile);
  let indent = configSource.match(/^([ \t]+)\S/m)?.[1] ?? "  ";
  let prefix = modulePrefix(project);
  let shape = serverShape(configSource, configFile);

  if (!shape) {
    result.blockers.push({
      title: "The default export of the mirage config is not a function",
      where: [configFile],
      action: `Follow ${MIGRATION} by hand.`,
    });

    return result;
  }

  for (let file of [
    "tests/helpers/mirage.js",
    "tests/helpers/mirage.ts",
    "app/initializers/mirage.js",
    "app/initializers/mirage.ts",
  ]) {
    if (project.has(file)) {
      result.blockers.push({ title: `${file} exists, and the stage writes it`, where: [file] });
    }
  }

  if (result.blockers.length > 0) return result;

  /**
   * ember-cli-mirage made a mirage model for each ember-data model, unless the app turned it off.
   * An app can turn it off in one environment only, as ember-observer did outside of tests,
   * so a model whose collection the mirage code names, such as `sizeCalculationResults`, gets one either way.
   */
  let discovery = !/discoverEmberDataModels\s*:\s*false/.test(environment);
  let mirageCode = project
    .files(["mirage/**/*.{js,ts}"])
    .map((file) => project.read(file))
    .join("\n");

  {
    let models = emberDataModels(project, prefix, result.todo);

    for (let [name, model] of models) {
      if (["js", "ts"].some((e) => project.has(`mirage/models/${name}.${e}`))) continue;
      if (!discovery && !new RegExp(`\\b${camelize(pluralize(name))}\\b`).test(mirageCode))
        continue;

      result.writes.set(
        `mirage/models/${name}.${model.ext}`,
        printMirageModel(model.relationships, indent),
      );
    }
  }

  /** @type {Record<string, string[]>} */
  let present = {};

  for (let { folder } of KINDS) {
    let names = new Set();

    for (let file of project.files([`mirage/${folder}/**/*.{js,ts}`])) {
      if (file.endsWith(".d.ts")) continue;

      let rest = file.slice(`mirage/${folder}/`.length);

      if (rest.includes("/")) {
        if (folder !== "fixtures") {
          result.todo.push({
            title: `Mirage ${folder} in subfolders are not imported`,
            where: [file],
            action: `Add them to mirage/${folder}.${ext}.`,
          });
        }

        continue;
      }

      if (hasDefaultExport(project.read(file), file)) names.add(rest.replace(/\.(js|ts)$/, ""));
    }

    if (folder === "models") {
      for (let file of result.writes.keys()) {
        if (file.startsWith("mirage/models/"))
          names.add(file.slice("mirage/models/".length).replace(/\.(js|ts)$/, ""));
      }
    }

    if (names.size > 0) {
      present[folder] = Array.from(names).sort();
      result.writes.set(`mirage/${folder}.${ext}`, printIndex(folder, present[folder], indent));
    }
  }

  let defaultScenario = ["js", "ts"].some((e) => project.has(`mirage/scenarios/default.${e}`));
  /**
   * ember-cli-mirage gave mirage the pluralize and singularize of ember-inflector, so the
   * inflection rules of the app apply. ember-cli-mirage also installed it for the mirage files.
   */
  let inflector =
    Boolean(project.dependency("ember-inflector") || project.dependency("ember-data")) ||
    project.files(SOURCES).some((file) => /['"]ember-inflector['"]/.test(project.read(file)));

  result.addInflector = inflector && !project.dependency("ember-inflector");

  result.writes.set(
    `mirage/servers/default.${ext}`,
    printServer({
      ext,
      indent,
      prefix,
      shape,
      kinds: KINDS.filter(({ folder }) => present[folder]),
      defaultScenario,
      inflector,
      trackRequests: /\btrackRequests\b/.test(environment),
    }),
  );
  result.writes.set(`app/initializers/mirage.${ext}`, printInitializer(ext, indent, prefix));

  let usesStartMirage = false;
  /**
   * ember-cli-mirage has no types, so TS apps wrote their own, in a types folder or a `declare module`.
   */
  let ownTypes = project
    .files(["**/*.d.ts"])
    .some(
      (file) =>
        file.includes(`/${OLD}/`) ||
        /declare module ['"]ember-cli-mirage['"]/.test(project.read(file)),
    );

  for (let file of project.files(SOURCES)) {
    let source = result.writes.get(file) ?? project.read(file);

    if (file === configFile && shape.kind === "make-server") {
      let edited = removeDiscovery(source, file);

      if (edited.serializers) {
        result.todo.push({
          title:
            "The mirage serializers do not get the primaryKey and attrs of the ember-data serializers",
          where: [file],
          action: `Copy them to the mirage serializers as \`transforms\`. See step 2 of ${MIGRATION}.`,
        });
      }

      source = edited.source;
    }

    if (source.includes(OLD)) {
      let rewritten = rewriteImports(source, file, { prefix, ownTypes });

      if (rewritten.startMirage) usesStartMirage = true;

      for (let leftover of rewritten.leftovers) {
        result.todo.push({
          title: `An import from ${OLD} has no replacement`,
          where: [`${file}: ${leftover}`],
          action: `See ${MIGRATION}.`,
        });
      }

      source = rewritten.source;
    }

    if (source.includes("mirage")) {
      let rewritten = rewriteMirageImports(source, file, prefix);

      for (let specifier of rewritten.leftovers) {
        result.todo.push({
          title: "An in-repo addon or engine imports from mirage/",
          where: [`${file}: ${specifier}`],
          action: `#mirage/* resolves only in the app and its tests. Move the import there.`,
        });
      }

      source = rewritten.source;
    }

    if (source !== project.read(file)) result.writes.set(file, source);
  }

  result.writes.set(`tests/helpers/mirage.${ext}`, printTestHelper(ext, indent, usesStartMirage));

  if (project.has("tsconfig.json")) {
    let source = project.read("tsconfig.json");
    let output = tsconfigForMirage(source, prefix);

    if (output !== source) result.writes.set("tsconfig.json", output);
  }

  if (ownTypes) {
    result.todo.push({
      title: `Types still come from the app's own declarations for ${OLD}`,
      action: `Imports used only as types stay as \`import type\` from ${OLD}. Move them to the types of ${MIRAGE}.`,
    });
  }

  result.todo = groupFindings(result.todo);

  return result;
}

/**
 * One finding for each title, with the places of all of them.
 *
 * @param {Finding[]} findings
 * @returns {Finding[]}
 */
function groupFindings(findings) {
  /** @type {Map<string, Finding>} */
  let byTitle = new Map();

  for (let finding of findings) {
    let existing = byTitle.get(finding.title);

    if (!existing) {
      byTitle.set(finding.title, Object.assign({}, finding, { where: finding.where?.slice() }));
    } else if (finding.where) {
      existing.where = (existing.where ?? []).concat(
        finding.where.filter((w) => !existing.where?.includes(w)),
      );
    }
  }

  return Array.from(byTitle.values());
}

/**
 * The newest version of the package in the lockfile, so that the app keeps the version it has.
 *
 * @param {import('#project.js').Project} project
 * @param {string} name
 * @returns {string | undefined}
 */
function lockedVersion(project, name) {
  let lockfile = project.lockfile;

  if (!lockfile) return;

  let source = readFileSync(lockfile.path, "utf8");
  let versions = Array.from(
    source.matchAll(new RegExp(`(?:^|[\\s/'"])${name}@(\\d+)\\.(\\d+)\\.(\\d+)`, "gm")),
    (m) => [Number(m[1]), Number(m[2]), Number(m[3])],
  );

  versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);

  return versions[0]?.join(".");
}

/**
 * @typedef {object} ServerShape
 * @property {"routes" | "make-server"} kind
 *   "routes": the default export is the routes function (deprecated in ember-cli-mirage 2.4).
 *   "make-server": the export takes the config and makes the server.
 * @property {string} [importName] a named export to import, when it is not the default export
 * @property {boolean} testConfig the config has a `testConfig` export
 */

/**
 * The forms that ember-cli-mirage 2.4 accepts, in its `start-mirage.js`.
 *
 * @param {string} source
 * @param {string} file
 * @returns {ServerShape | undefined}
 */
export function serverShape(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  /** @type {ServerShape | undefined} */
  let shape;
  let testConfig = false;
  /** @type {Map<string, Node>} */
  let functions = new Map();

  for (let node of /** @type {Node[]} */ (program.body)) {
    let declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;

    if (declaration?.type === "FunctionDeclaration" && declaration.id)
      functions.set(declaration.id.name, declaration);
    if (declaration?.type === "VariableDeclaration") {
      for (let d of declaration.declarations) {
        if (d.id.type === "Identifier" && /Function/.test(d.init?.type ?? ""))
          functions.set(d.id.name, d.init);
      }
    }
  }

  for (let node of /** @type {Node[]} */ (program.body)) {
    if (node.type === "ExportNamedDeclaration") {
      let names = node.declaration
        ? node.declaration.id
          ? [node.declaration.id.name]
          : (node.declaration.declarations ?? []).map((/** @type {Node} */ d) => d.id.name)
        : node.specifiers.map((/** @type {Node} */ s) => s.exported.name);

      if (names.includes("testConfig")) testConfig = true;
      if (names.includes("makeServer"))
        shape ??= { kind: "make-server", importName: "makeServer", testConfig: false };
    }
  }

  for (let node of /** @type {Node[]} */ (program.body)) {
    if (node.type !== "ExportDefaultDeclaration") continue;

    let fn = node.declaration;

    if (fn.type === "Identifier") fn = functions.get(fn.name);
    if (!fn || !/Function/.test(fn.type)) return;

    /**
     * A TS `this` parameter is not a parameter at runtime.
     */
    let params = fn.params.filter(
      (/** @type {Node} */ p) => !(p.type === "Identifier" && p.name === "this"),
    );

    shape = { kind: params.length === 0 ? "routes" : "make-server", testConfig: false };
  }

  if (shape) shape.testConfig = testConfig;

  return shape;
}

/**
 * The files in app/models that are ember-data models, with their relationships.
 *
 * @param {import('#project.js').Project} project
 * @param {string} prefix
 * @param {Finding[]} todo
 * @returns {Map<string, { ext: string, relationships: Relationship[] }>}
 */
function emberDataModels(project, prefix, todo) {
  /** @type {Map<string, ModelInfo | undefined>} */
  let infos = new Map();

  /**
   * @param {string} file
   */
  let info = (file) => {
    if (!infos.has(file)) infos.set(file, readModel(project.read(file), file));

    return infos.get(file);
  };

  /**
   * Relationships of the parent classes first, so the model overrides them.
   *
   * @param {string} file
   * @param {Set<string>} seen
   * @returns {Relationship[]}
   */
  let relationships = (file, seen) => {
    let model = info(file);

    if (!model || seen.has(file)) return [];

    seen.add(file);

    /** @type {Map<string, Relationship>} */
    let all = new Map();

    for (let parent of model.parents) {
      let parentFile = resolveModel(project, prefix, file, parent);

      if (parentFile) {
        for (let r of relationships(parentFile, seen)) all.set(r.name, r);
      } else {
        todo.push({
          title: "Mirage models do not have the relationships of a parent class",
          where: [`${file}: ${parent}`],
          action: "Add those relationships to the mirage model.",
        });
      }
    }

    for (let r of model.relationships) all.set(r.name, r);

    return Array.from(all.values());
  };

  /** @type {Map<string, { ext: string, relationships: Relationship[] }>} */
  let models = new Map();

  for (let file of project.files(["app/models/*.{js,ts}"])) {
    if (file.endsWith(".d.ts")) continue;

    let model = info(file);

    if (!model) continue;

    for (let problem of model.problems) {
      todo.push({
        title: "A relationship is not copied to its mirage model",
        where: [`${file}: ${problem}`],
        action: "Add it to the mirage model by hand.",
      });
    }

    let name = file.slice("app/models/".length).replace(/\.(js|ts)$/, "");

    models.set(name, {
      ext: file.endsWith(".ts") ? "ts" : "js",
      relationships: relationships(file, new Set()),
    });
  }

  return models;
}

/**
 * @param {import('#project.js').Project} project
 * @param {string} prefix
 * @param {string} from the model file that imports the parent
 * @param {string} specifier
 * @returns {string | undefined}
 */
function resolveModel(project, prefix, from, specifier) {
  let base;

  if (specifier.startsWith(".")) base = posix.join(posix.dirname(from), specifier);
  else if (specifier.startsWith(`${prefix}/`)) base = `app/${specifier.slice(prefix.length + 1)}`;
  else return;

  return ["ts", "js"].map((e) => `${base}.${e}`).find((file) => project.has(file));
}

/**
 * @typedef {object} Relationship
 * @property {string} name
 * @property {"belongsTo" | "hasMany"} kind
 * @property {string} [type] the model name, when ember-data has one
 * @property {string[]} options source text of each option that mirage reads
 */

/**
 * @typedef {object} ModelInfo
 * @property {Relationship[]} relationships the ones in this file
 * @property {string[]} parents the import specifiers of the parent classes
 * @property {string[]} problems relationships that the stage cannot copy
 */

/**
 * Reads the relationships of an ember-data model, from decorators and from `Model.extend({})`.
 *
 * @param {string} source
 * @param {string} file
 * @returns {ModelInfo | undefined} undefined when the file is not an ember-data model
 */
export function readModel(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  /** @type {Map<string, string>} local name to import specifier */
  let imports = new Map();
  /** @type {Map<string, string>} local name to "belongsTo", "hasMany", or "Model" */
  let emberData = new Map();
  /** @type {Set<string>} local names of `import DS from 'ember-data'` */
  let namespaces = new Set();
  /** @type {Map<string, Node>} */
  let classes = new Map();
  /** @type {Node | undefined} */
  let exported;

  for (let node of /** @type {Node[]} */ (program.body)) {
    if (node.type === "ImportDeclaration") {
      let from = node.source.value;

      for (let s of node.specifiers) {
        imports.set(s.local.name, from);

        if (from === "@ember-data/model" || from === "ember-data") {
          if (s.type === "ImportDefaultSpecifier") {
            if (from === "ember-data") namespaces.add(s.local.name);
            else emberData.set(s.local.name, "Model");
          } else if (s.type === "ImportSpecifier") {
            emberData.set(s.local.name, s.imported.name);
          }
        }
      }
    }

    if (node.type === "ClassDeclaration" && node.id) classes.set(node.id.name, node);
    if (node.type === "ExportDefaultDeclaration") exported = node.declaration;
  }

  if (emberData.size === 0 && namespaces.size === 0) return;
  if (exported?.type === "Identifier") exported = classes.get(exported.name);
  if (!exported) return;

  /** @type {ModelInfo} */
  let info = { relationships: [], parents: [], problems: [] };

  /**
   * @param {Node | undefined} callee
   * @returns {string | undefined}
   */
  let relationshipKind = (callee) => {
    let name;

    if (callee?.type === "Identifier") name = emberData.get(callee.name);
    if (callee?.type === "MemberExpression" && namespaces.has(callee.object.name))
      name = callee.property.name;

    return name === "belongsTo" || name === "hasMany" ? name : undefined;
  };

  /**
   * @param {string} name
   * @param {Node} value a call, or a bare decorator
   */
  let addRelationship = (name, value) => {
    let callee = value.type === "CallExpression" ? value.callee : value;
    let kind = relationshipKind(callee);

    if (!kind) return;

    let args = value.type === "CallExpression" ? value.arguments : [];
    /** @type {Relationship} */
    let relationship = { name, kind: /** @type {"belongsTo" | "hasMany"} */ (kind), options: [] };
    let optionsNode = args[0]?.type === "ObjectExpression" ? args[0] : args[1];

    if (args[0]?.type === "Literal" && typeof args[0].value === "string")
      relationship.type = args[0].value;
    else if (args[0] && args[0].type !== "ObjectExpression") {
      info.problems.push(`${name}: the model name is not a string`);
      return;
    }

    if (optionsNode && optionsNode.type !== "ObjectExpression") {
      info.problems.push(`${name}: the options are not an object`);
      return;
    }

    for (let property of optionsNode?.properties ?? []) {
      let key = propertyName(property);

      if (key !== "inverse" && key !== "polymorphic") continue;

      if (property.value.type !== "Literal") {
        info.problems.push(`${name}: ${key} is not a literal`);
        return;
      }

      relationship.options.push(
        `${key}: ${source.slice(property.value.start, property.value.end)}`,
      );
    }

    info.relationships.push(relationship);
  };

  /**
   * @param {Node} node a superclass, or the default export
   */
  let readParent = (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property.name === "extend"
    ) {
      for (let arg of node.arguments) {
        if (arg.type !== "ObjectExpression") continue;

        for (let property of arg.properties) {
          let key = propertyName(property);

          if (key && property.value.type === "CallExpression") addRelationship(key, property.value);
        }
      }

      readParent(node.callee.object);
      return;
    }

    if (node.type === "Identifier") {
      if (emberData.get(node.name) === "Model") return;

      let from = imports.get(node.name);

      if (from && from !== "@ember-data/model" && from !== "ember-data") info.parents.push(from);

      return;
    }

    if (node.type === "MemberExpression" && namespaces.has(node.object.name)) return;

    info.problems.push(`the parent class ${source.slice(node.start, node.end)}`);
  };

  if (exported.type === "ClassDeclaration" || exported.type === "ClassExpression") {
    if (exported.superClass) readParent(exported.superClass);

    for (let member of exported.body.body) {
      let key = member.key?.type === "Identifier" ? member.key.name : undefined;

      if (!key) continue;

      for (let decorator of member.decorators ?? []) addRelationship(key, decorator.expression);
    }
  } else {
    readParent(exported);
  }

  return info;
}

/**
 * @param {Relationship[]} relationships
 * @param {string} indent
 * @returns {string}
 */
export function printMirageModel(relationships, indent) {
  let kinds = new Set(relationships.map((r) => r.kind));
  let names = ["Model"].concat(
    ["belongsTo", "hasMany"].filter((k) => kinds.has(/** @type {any} */ (k))),
  );
  let lines = relationships.map((r) => {
    let args = [];

    if (r.type) args.push(`'${r.type}'`);
    if (r.options.length > 0) args.push(`{ ${r.options.join(", ")} }`);

    return `${indent}${r.name}: ${r.kind}(${args.join(", ")}),`;
  });

  let body = lines.length > 0 ? `{\n${lines.join("\n")}\n}` : "{}";

  return `import { ${names.join(", ")} } from '${MIRAGE}';\n\nexport default Model.extend(${body});\n`;
}

/**
 * @param {string} name a file name, such as "registration-schema"
 * @returns {string}
 */
function camelize(name) {
  return name.replace(/[-_.]+(.)/g, (_, c) => c.toUpperCase());
}

/**
 * ember-cli-mirage named fixtures with ember-inflector's pluralize. These rules cover regular nouns.
 *
 * @param {string} name
 * @returns {string}
 */
function pluralize(name) {
  if (name.endsWith("s")) return name;
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  if (/(x|z|ch|sh)$/.test(name)) return `${name}es`;

  return `${name}s`;
}

/**
 * @param {string} name
 * @param {string} suffix
 */
function localName(name, suffix) {
  let local = camelize(name);

  return RESERVED.has(local) || !/^[A-Za-z_$][\w$]*$/.test(local)
    ? `${local.replace(/[^\w$]/g, "_")}${suffix}`
    : local;
}

/**
 * One module that imports every file of a mirage folder, as ember-cli-mirage found them at runtime.
 *
 * @param {string} folder
 * @param {string[]} names file names without the extension
 * @param {string} indent
 * @returns {string}
 */
export function printIndex(folder, names, indent) {
  let suffix = camelize(`-${folder}`).replace(/ies$/, "y").replace(/s$/, "");
  let imports = names.map(
    (name) => `import ${localName(name, suffix)} from './${folder}/${name}';`,
  );
  let entries = names.map((name) => {
    let key = camelize(folder === "fixtures" ? pluralize(name) : name);
    let local = localName(name, suffix);

    return key === local ? `${indent}${key},` : `${indent}${key}: ${local},`;
  });

  return `${imports.join("\n")}\n\nexport default {\n${entries.join("\n")}\n};\n`;
}

/**
 * @param {object} options
 * @param {string} options.ext
 * @param {string} options.indent
 * @param {string} options.prefix
 * @param {ServerShape} options.shape
 * @param {{ folder: string, key: string }[]} options.kinds the folders that have files
 * @param {boolean} options.defaultScenario
 * @param {boolean} options.inflector
 * @param {boolean} options.trackRequests
 * @returns {string}
 */
export function printServer({
  ext,
  indent,
  prefix,
  shape,
  kinds,
  defaultScenario,
  inflector,
  trackRequests,
}) {
  let i = indent;
  let imports = [];
  let config = [`${i}${i}environment,`];

  if (shape.kind === "routes") imports.push(`import { createServer } from '${MIRAGE}';`);
  if (inflector) imports.push(`import { pluralize, singularize } from 'ember-inflector';`);
  if (trackRequests) imports.push(`import config from '${prefix}/config/environment';`);

  imports.push("");

  let configImports = [];

  if (shape.kind === "routes") configImports.push("routes");
  else if (!shape.importName) configImports.push("makeServerFromConfig");

  let named = [];

  if (shape.importName) named.push(`${shape.importName} as makeServerFromConfig`);
  if (shape.testConfig) named.push("testConfig");
  if (named.length > 0) configImports.push(`{ ${named.join(", ")} }`);

  imports.push(`import ${configImports.join(", ")} from '../config';`);

  for (let { folder, key } of kinds) {
    imports.push(`import ${key} from '../${folder}';`);
    config.push(`${i}${i}${key},`);
  }

  if (defaultScenario) {
    imports.push(`import defaultScenario from '../scenarios/default';`);
    config.push(`${i}${i}scenarios: { default: defaultScenario },`);
  }

  if (trackRequests)
    config.push(`${i}${i}trackRequests: config['ember-cli-mirage']?.trackRequests,`);
  if (inflector) config.push(`${i}${i}inflector: { pluralize, singularize },`);
  if (shape.testConfig) config.push(`${i}${i}testConfig,`);
  if (shape.kind === "routes") config.push(`${i}${i}routes,`);

  let call = shape.kind === "routes" ? "createServer" : "makeServerFromConfig";
  let param = ext === "ts" ? "environment: string" : "environment";

  return `${imports.join("\n")}

/**
 * ember-cli-mirage found these modules at runtime. ember-mirage needs them imported.
 */
export default function makeServer(${param}) {
${i}return ${call}({
${config.join("\n")}
${i}});
}
`;
}

/**
 * @param {string} ext
 * @param {string} indent
 * @param {string} prefix
 * @returns {string}
 */
export function printInitializer(ext, indent, prefix) {
  let i = indent;
  let ts = ext === "ts";
  let settingsType = ts ? ": { enabled?: boolean; usingProxy?: boolean }" : "";
  let cast = ts ? " as { default: (environment: string) => unknown }" : "";

  return `import { importSync, isDevelopingApp, isTesting, macroCondition } from '@embroider/macros';
import config from '${prefix}/config/environment';

/**
 * ember-cli-mirage started the server from its own initializer, with these rules.
 * The import stays in the macro branch, so production builds have no mirage code.
 */
export function initialize() {
${i}if (macroCondition(isDevelopingApp())) {
${i}${i}let settings${settingsType} = config['ember-cli-mirage'] ?? {};
${i}${i}let enabled = settings.enabled ?? (config.environment === 'development' && !settings.usingProxy);

${i}${i}if (enabled && !isTesting() && !('FastBoot' in globalThis)) {
${i}${i}${i}let { default: makeServer } = importSync('#mirage/servers/default')${cast};

${i}${i}${i}makeServer(config.environment);
${i}${i}}
${i}}
}

export default { initialize };
`;
}

/**
 * @param {string} ext
 * @param {string} indent
 * @param {boolean} startMirage the tests imported startMirage from the ember-cli-mirage initializer
 * @returns {string}
 */
export function printTestHelper(ext, indent, startMirage) {
  let i = indent;
  let hooks = ext === "ts" ? "hooks: NestedHooks" : "hooks";
  let text = `import { setupMirage as upstreamSetupMirage } from '${NEW}/test-support';
import makeServer from '#mirage/servers/default';

/**
 * ember-cli-mirage found the server config by itself. ember-mirage takes it as an option.
 */
export function setupMirage(${hooks}) {
${i}upstreamSetupMirage(hooks, { createServer: () => makeServer('test') });
}
`;

  if (startMirage) {
    text += `
/**
 * For tests that start and stop the server themselves.
 */
export function startMirage() {
${i}return makeServer('test');
}
`;
  }

  return text;
}

/**
 * @param {string} source
 * @param {string} file
 */
function hasDefaultExport(source, file) {
  let program = parseProgram(source, file);

  return Boolean(
    program?.body.some(
      (/** @type {Node} */ node) =>
        node.type === "ExportDefaultDeclaration" ||
        (node.type === "ExportNamedDeclaration" &&
          node.specifiers.some((/** @type {Node} */ s) => s.exported.name === "default")),
    ),
  );
}

/**
 * The makeServer form of the config called the discovery helpers of ember-cli-mirage.
 * The models are files now, and the server module passes them in `config.models`.
 *
 * @param {string} source
 * @param {string} file
 * @returns {{ source: string, serializers: boolean }}
 */
export function removeDiscovery(source, file) {
  let program = parseProgram(source, file);
  let serializers = false;

  if (!program) return { source, serializers };

  let edits = new Edits(source);

  walk(program, (node) => {
    if (
      node.type === "SpreadElement" &&
      node.argument.type === "CallExpression" &&
      node.argument.callee.name === "discoverEmberDataModels"
    ) {
      let after = source.slice(node.end).match(/^\s*,[ \t]*/);

      edits.replace({ start: node.start, end: node.end + (after ? after[0].length : 0) }, "");
      return SKIP;
    }

    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      if (node.callee.name === "discoverEmberDataModels") {
        edits.replace(node, "{}");
        return SKIP;
      }

      if (node.callee.name === "applyEmberDataSerializers") {
        serializers = true;

        let arg = node.arguments[0];

        edits.replace(node, arg ? source.slice(arg.start, arg.end) : "{}");
        return SKIP;
      }
    }
  });

  return { source: edits.size > 0 ? edits.apply() : source, serializers };
}

/**
 * Local names that the code uses as values. Names that only types use are not in the set.
 *
 * @param {Node} program
 * @returns {Set<string>}
 */
function valueNames(program) {
  /** @type {Set<string>} */
  let names = new Set();

  walk(program, (node) => {
    if (node.type === "ImportDeclaration") return SKIP;
    if (node.type.startsWith("TS") && !TS_VALUES.has(node.type)) return SKIP;
    if (node.type === "Identifier") names.add(node.name);
  });

  return names;
}

/**
 * @param {string} source
 * @param {string} file
 * @param {{ prefix: string, ownTypes: boolean }} options
 *   ownTypes: the app declares `module 'ember-cli-mirage'` in its own .d.ts files
 * @returns {{ source: string, leftovers: string[], startMirage: boolean }}
 */
export function rewriteImports(source, file, { prefix, ownTypes }) {
  let program = parseProgram(source, file);
  /** @type {string[]} */
  let leftovers = [];
  let startMirage = false;

  if (!program) return { source, leftovers, startMirage };

  let ts = /\.g?ts$/.test(file);
  let values = valueNames(program);
  let edits = new Edits(source);
  let helper = `${prefix}/tests/helpers/mirage`;

  for (let node of /** @type {Node[]} */ (program.body)) {
    let specifier = node.source;
    /** @type {string} */
    let from = specifier?.value;

    if (typeof from !== "string") continue;

    let quote = source[specifier.start];

    /**
     * Classic modules shared one namespace, so `../../initializers/ember-cli-mirage` in tests/helpers named the app's initializer.
     */
    if (from.startsWith(".")) {
      let modulePath = `${prefix}/${file.replace(/^app\//, "")}`;
      let resolved = posix.normalize(posix.join(posix.dirname(modulePath), from));

      if (resolved === `${prefix}/initializers/${OLD}`) from = resolved;
    }

    let isOld =
      from === OLD || from.startsWith(`${OLD}/`) || from === `${prefix}/initializers/${OLD}`;

    if (!isOld) continue;

    if (node.type !== "ImportDeclaration") {
      leftovers.push(`export from "${from}"`);
      continue;
    }

    if (from === `${OLD}/test-support` || from === `${prefix}/initializers/${OLD}`) {
      if (from !== `${OLD}/test-support`) startMirage = true;

      edits.replace(specifier, `${quote}${helper}${quote}`);
      continue;
    }

    if (from === `${OLD}/serializers/ember-data-serializer`) {
      edits.replace(specifier, `${quote}${NEW}/ember-data-serializer${quote}`);
      continue;
    }

    let typeOnly = node.importKind === "type";

    if (from !== OLD) {
      if (!(
        ts &&
        ownTypes &&
        (typeOnly || node.specifiers.every((/** @type {Node} */ s) => !values.has(s.local.name)))
      )) {
        leftovers.push(`import from "${from}"`);
      }

      continue;
    }

    if (typeOnly) {
      if (!ownTypes) edits.replace(specifier, `${quote}${MIRAGE}${quote}`);
      continue;
    }

    /** @type {string[]} */
    let lines = [];
    /** @type {string[]} */
    let mirage = [];
    /** @type {string[]} */
    let types = [];
    let handled = true;

    for (let s of node.specifiers) {
      let text = source.slice(s.start, s.end).replace(/^type\s+/, "");
      let local = s.local.name;

      if (s.type === "ImportDefaultSpecifier") {
        lines.push(`import ${local} from ${quote}${MIRAGE}${quote};`);
      } else if (s.type === "ImportNamespaceSpecifier") {
        lines.push(`import * as ${local} from ${quote}${MIRAGE}${quote};`);
      } else if (ts && ownTypes && (s.importKind === "type" || !values.has(local))) {
        types.push(text);
      } else if (DISCOVERY.has(s.imported.name)) {
        if (values.has(local)) {
          leftovers.push(`${s.imported.name} from "${from}"`);
          handled = false;
        }
      } else if (s.imported.name === "EmberDataSerializer") {
        lines.push(`import ${local} from ${quote}${NEW}/ember-data-serializer${quote};`);
      } else if (
        MIRAGE_EXPORTS.has(s.imported.name) ||
        (ts && s.importKind === "type") ||
        (ts && !values.has(local))
      ) {
        mirage.push(text);
      } else {
        leftovers.push(`${s.imported.name} from "${from}"`);
        handled = false;
      }
    }

    if (!handled) continue;

    if (mirage.length > 0)
      lines.unshift(`import { ${mirage.join(", ")} } from ${quote}${MIRAGE}${quote};`);
    if (types.length > 0)
      lines.push(`import type { ${types.join(", ")} } from ${quote}${OLD}${quote};`);

    if (lines.length > 0) edits.replace(node, lines.join("\n"));
    else edits.removeLine(node);
  }

  return { source: edits.size > 0 ? edits.apply() : source, leftovers, startMirage };
}

/**
 * Imports of mirage/ through the module prefix or a relative path.
 * The app and the tests get `#mirage/...`. mirage/ itself keeps relative paths.
 * In-repo addons have their own package.json, so `#mirage/*` does not resolve there.
 *
 * @param {string} source
 * @param {string} file
 * @param {string} prefix
 * @returns {{ source: string, leftovers: string[] }}
 */
export function rewriteMirageImports(source, file, prefix) {
  let program = parseProgram(source, file);
  /** @type {string[]} */
  let leftovers = [];

  if (!program) return { source, leftovers };

  let edits = new Edits(source);
  let inMirage = file.startsWith("mirage/");

  walk(program, (node) => {
    let specifier =
      node.type === "ImportDeclaration" ||
      node.type === "ImportExpression" ||
      ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
        node.source)
        ? node.source
        : undefined;

    if (specifier?.type !== "Literal" || typeof specifier.value !== "string") return;

    let from = specifier.value;
    /** @type {string | undefined} */
    let path;

    if (from.startsWith(`${prefix}/mirage/`)) path = from.slice(prefix.length + 1);
    else if (from.startsWith(".") && !inMirage) {
      let joined = posix.join(posix.dirname(file), from);

      if (joined.startsWith("mirage/")) path = joined;
    }

    if (!path) return;

    if (file.startsWith("lib/")) {
      leftovers.push(from);
      return;
    }

    let quote = source[specifier.start];
    let next = inMirage
      ? posix.relative(posix.dirname(file), path).replace(/^(?!\.)/, "./")
      : `#${path}`;

    edits.replace(specifier, `${quote}${next}${quote}`);
  });

  return { source: edits.size > 0 ? edits.apply() : source, leftovers };
}

/**
 * TS reads `paths`, not package.json `imports`, with the old `moduleResolution: node`.
 * So a path entry for `<prefix>/mirage/*` becomes the one for `#mirage/*`.
 *
 * @param {string} source tsconfig.json, which can have comments
 * @param {string} prefix
 * @returns {string}
 */
export function tsconfigForMirage(source, prefix) {
  let escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let output = source.replace(new RegExp(`(["'])${escaped}/mirage/\\*\\1`), `$1${IMPORT_KEY}$1`);
  let include = output.match(/(["']include["']\s*:\s*\[)([^\]]*)\]/);

  if (!include) return output;

  let entries = Array.from(include[2].matchAll(/["']([^"']+)["']/g), (m) => m[1]);

  if (entries.some((entry) => /^(\.\/)?(mirage|\*\*)(\/|$)/.test(entry))) return output;

  let body = include[2].replace(/\s+$/, "");
  let item = body.match(/\n([ \t]+)\S/);
  let addition = item ? `,\n${item[1]}"mirage/**/*"` : `, "mirage/**/*"`;

  if (entries.length === 0) addition = `"mirage/**/*"`;

  let start = (include.index ?? 0) + include[1].length;

  return output.slice(0, start) + body + addition + output.slice(start + body.length);
}
