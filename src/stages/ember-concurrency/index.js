import { parseProgram, walk } from "#ast.js";
import { modernizeTasks } from "#codemods/ember-concurrency/index.js";
import { buildFile } from "#config-files.js";
import { Edits } from "#edits.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { atLeast } from "#version.js";

/** @typedef {import('#types.js').Finding} Finding */

const TRANSFORM = "ember-concurrency/async-arrow-task-transform";
const BABEL_CONFIGS = ["babel.config.js", "babel.config.mjs", "babel.config.cjs"];

/**
 * Adds the babel transform of ember-concurrency as the first plugin.
 *
 * @param {string} source a babel config
 * @param {string} file
 * @returns {string | undefined} undefined when the config has no `plugins` array
 */
export function addTaskTransform(source, file) {
  if (source.includes(TRANSFORM)) return source;

  let program = parseProgram(source, file);
  /** @type {import('#ast.js').Node | undefined} */
  let plugins;

  walk(program, (node) => {
    let key = node.key?.name ?? node.key?.value;

    if (!plugins && node.type === "Property" && key === "plugins") {
      if (node.value.type === "ArrayExpression") plugins = node.value;
    }
  });

  if (!plugins) return;

  let edits = new Edits(source);
  let first = plugins.elements[0];

  if (first) {
    let lineStart = source.lastIndexOf("\n", first.start - 1) + 1;
    let before = source.slice(lineStart, first.start);
    let separator = before.trim() === "" ? `\n${before}` : " ";

    edits.insert(first.start, `"${TRANSFORM}",${separator}`);
  } else {
    edits.insert(plugins.start + 1, `"${TRANSFORM}"`);
  }

  return edits.apply();
}

/**
 * The compat build merges the `babel` options of ember-cli-build with the Babel config, and Babel stops at a plugin that is in both.
 *
 * @param {import('#project.js').Project} project
 * @returns {boolean} ember-cli-build already adds the transform
 */
function buildHasTransform(project) {
  let file = buildFile(project);

  return Boolean(file && project.read(file).includes(TRANSFORM));
}

/**
 * @param {import('#project.js').Project} project
 */
function babelConfig(project) {
  return BABEL_CONFIGS.find((file) => project.has(file));
}

/**
 * @param {import('#project.js').Project} project
 * @returns {{ changes: Map<string, string>, blockers: Finding[] }}
 */
function plan(project) {
  /** @type {Map<string, string>} */
  let changes = new Map();
  /** @type {Finding[]} */
  let blockers = [];

  for (let file of project.files()) {
    let source = project.read(file);

    if (!source.includes("ember-concurrency")) continue;

    let result = modernizeTasks(source, file);

    if (result.unreadable.length > 0) {
      blockers.push({
        title: `Tasks that the codemod cannot move to ember-concurrency 5: ${result.unreadable.join("; ")}`,
        where: [file],
        action:
          "Write each task as `name = task({ drop: true }, async () => {})` in a native class. " +
          "See https://ember-concurrency.com/docs/v4-upgrade.",
      });
    } else if (result.source !== source) {
      changes.set(file, result.source);
    }
  }

  let babel = babelConfig(project);

  if (!buildHasTransform(project) && (!babel || !addTaskTransform(project.read(babel), babel))) {
    blockers.push({
      title: "No babel config with a `plugins` array for the transform of ember-concurrency",
      where: babel ? [babel] : [],
      action: `Add "${TRANSFORM}" to the babel plugins.`,
    });
  }

  return { changes, blockers };
}

/**
 * ember-concurrency 5 runs only the tasks of native classes in the `task(async () => {})` syntax,
 * which a babel transform compiles. Earlier stages update to v4, which runs both syntaxes.
 * This stage runs after classic-components, when the components are native classes.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ember-concurrency",
  label: "Move the tasks to the syntax of ember-concurrency 5, and update it",

  detect(project) {
    let range = project.dependency("ember-concurrency");

    return (
      Boolean(project.dependency("ember-concurrency-decorators")) ||
      (Boolean(range) && !atLeast(range, 5, 0))
    );
  },

  async check(project) {
    return { blockers: plan(project).blockers, todo: [] };
  },

  async run(project) {
    let { changes } = plan(project);

    for (let [file, source] of changes) project.write(file, source);

    if (!buildHasTransform(project)) {
      let babel = /** @type {string} */ (babelConfig(project));

      project.write(babel, /** @type {string} */ (addTaskTransform(project.read(babel), babel)));
    }

    let release = published("ember-concurrency");

    editPackageJson(project, (pkg) => {
      removeDependency(pkg, "ember-concurrency-decorators");
      setDependency(pkg, "ember-concurrency", `^${release?.version ?? "5.3.0"}`);
    });

    return [];
  },
};
