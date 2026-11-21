import { parseProgram, propertyName, walk } from "#ast.js";
import { addVitePlugin, viteConfig } from "#config-files.js";
import { Edits } from "#edits.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#ast.js').Node} Node */

const BABEL_CONFIGS = ["babel.config.mjs", "babel.config.cjs", "babel.config.js"];
const DOCS = "https://github.com/auditboard/ember-scoped-css#configuration";

/**
 * Adds the ember-scoped-css plugins to the configs that the vite stage made.
 * The ember-css-modules stage runs before the vite stage, when these configs do not exist yet.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ember-scoped-css",
  label: "Add the ember-scoped-css plugins to the Vite and Babel configs",

  detect(project) {
    let config = viteConfig(project);

    /**
     * ember-scoped-css-compat is the v1 addon setup of ember-scoped-css before 1.0,
     * which still builds after the vite stage. The plugins here are for 1.0 and later.
     */
    return Boolean(
      project.dependency("ember-scoped-css") &&
      !project.dependency("ember-scoped-css-compat") &&
      config &&
      !project.read(config).includes("ember-scoped-css/vite"),
    );
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let roots = additionalRoots(project);
    let options = roots.length
      ? `{ additionalRoots: [${roots.map((root) => `'${root}'`).join(", ")}] }`
      : "";
    let todo = [];

    let added = addVitePlugin(project, {
      importLine: "import { scopedCSS } from 'ember-scoped-css/vite';",
      call: `scopedCSS(${options})`,
      specifier: "ember-scoped-css/vite",
      first: true,
    });

    if (!added) {
      todo.push({
        title: "Add the scopedCSS plugin to the Vite config",
        where: [viteConfig(project) ?? "vite.config.mjs"],
        action: DOCS,
      });
    }

    let babel = BABEL_CONFIGS.find((file) => project.has(file));
    let output = babel && addTemplateTransform(project.read(babel), babel, options);

    if (babel && output) {
      project.write(babel, output);
    } else {
      todo.push({
        title: "Add scopedCSS.template() to the template transforms in the Babel config",
        where: [babel ?? "babel.config.mjs"],
        action: DOCS,
      });
    }

    if (roots.some((root) => root.startsWith("lib/"))) {
      recordProgress(project, {
        id: "ember-scoped-css: in-repo addons",
        status: "check",
        note:
          `The styles in ${roots.filter((root) => root.startsWith("lib/")).join(", ")} need ember-scoped-css to read those folders. ` +
          "Embroider moves v1 addons before the build, so make sure that their styles apply, or move each one to a v2 addon.",
        links: [DOCS],
      });
    }

    return todo;
  },
};

/**
 * ember-scoped-css reads only components, templates, and routes of the app.
 * Pods and in-repo addons need `additionalRoots`.
 *
 * @param {import('#project.js').Project} project
 * @returns {string[]}
 */
export function additionalRoots(project) {
  /** @type {Set<string>} */
  let roots = new Set();

  for (let file of project.files(["app/**/*.hbs", "lib/*/addon/**/*.hbs"])) {
    if (!project.read(file).includes("<style scoped")) continue;

    if (file.startsWith("lib/")) {
      roots.add(file.split("/").slice(0, 3).join("/"));
    } else if (!/^app\/(components|templates|routes)\//.test(file)) {
      roots.add("app");
    }
  }

  return Array.from(roots).sort();
}

/**
 * Adds `scopedCSS.template()` to the `transforms` of babel-plugin-ember-template-compilation, and its import.
 *
 * @param {string} source
 * @param {string} file
 * @param {string} options
 * @returns {string | undefined} undefined when the config has no `transforms` array
 */
export function addTemplateTransform(source, file, options) {
  let program = parseProgram(source, file);

  if (!program) return;

  /** @type {Node | undefined} */
  let transforms;

  walk(program, (node) => {
    if (
      !transforms &&
      propertyName(node) === "transforms" &&
      node.value.type === "ArrayExpression"
    ) {
      transforms = node.value;
    }
  });

  if (!transforms) return;

  let edits = new Edits(source);
  let call = `scopedCSS.template(${options})`;
  let last = transforms.elements[transforms.elements.length - 1];

  if (last) edits.insert(last.end, `, ${call}`);
  else edits.insert(transforms.start + 1, call);

  let esm = program.body.some((/** @type {Node} */ node) => node.type === "ImportDeclaration");
  let imports = program.body.filter(
    (/** @type {Node} */ node) =>
      node.type === "ImportDeclaration" ||
      (node.type === "VariableDeclaration" &&
        /\brequire\(/.test(source.slice(node.start, node.end))),
  );
  let line = esm
    ? "import { scopedCSS } from 'ember-scoped-css/babel';"
    : "const { scopedCSS } = require('ember-scoped-css/babel');";
  let after = imports[imports.length - 1];

  edits.insert(after ? after.end : 0, after ? `\n${line}` : `${line}\n`);

  return edits.apply();
}
