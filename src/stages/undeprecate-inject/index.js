import { join } from "node:path";

import { parseProgram, walk } from "#ast.js";
import { viteConfig } from "#config-files.js";
import { Edits } from "#edits.js";
import { dependencyNames, editPackageJson, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";
import { Project } from "#project.js";

/** @typedef {import('#ast.js').Node} Node */

const PLUGIN = "babel-plugin-undeprecate-inject-from-at-ember-service";
const BABEL_CONFIGS = ["babel.config.js", "babel.config.mjs", "babel.config.cjs"];
const INJECT = /\bimport\s*\{[^}]*\binject\b[^}]*\}\s*from\s*["']@ember\/service["']/;

/**
 * The pattern that makes ember() send a file to babel. It is the source of a RegExp in vite.config.
 */
const WHEN_MATCHING = String.raw`/\binject\b[^;]*from\s*['"]@ember\/service['"]/`;

/**
 * @param {Project} project
 * @returns {string[]} the dependencies whose installed code imports `inject` from @ember/service
 */
export function injectUsers(project) {
  return dependencyNames(project.packageJson).filter((name) => {
    let dependency = new Project(join(project.directory, "node_modules", name));

    if (!dependency.has("package.json")) return false;

    return dependency
      .files(["**/*.{js,mjs}"])
      .filter((file) => !/(^|\/)tests?\//.test(file))
      .some((file) => INJECT.test(dependency.read(file)));
  });
}

/**
 * Adds `babel: { include: { whenMatching: [...] } }` to an `ember()` call without options.
 *
 * @param {string} source vite.config
 * @param {string} file
 * @returns {string | undefined} undefined when `ember()` is not there, or already has options
 */
export function addBabelMatch(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  /** @type {Node | undefined} */
  let call;

  walk(program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "ember" &&
      node.arguments.length === 0
    ) {
      call = node;
    }
  });

  if (!call) return;

  let edits = new Edits(source);

  edits.replace(call, `ember({ babel: { include: { whenMatching: [${WHEN_MATCHING}] } } })`);

  return edits.apply();
}

/**
 * Ember 7 removed `inject` from @ember/service. A dependency without a fixed release still imports it,
 * so the app compiles those imports to `service` with a babel plugin.
 * @nullvoxpopuli/ember-vite runs babel on a dependency only when a file matches a pattern, so ember() gets one.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "undeprecate-inject",
  label: `Compile \`inject\` from @ember/service in dependencies to \`service\` (${PLUGIN})`,

  detect(project) {
    let config = viteConfig(project);

    return Boolean(
      config &&
      project.dependency("@nullvoxpopuli/ember-vite") &&
      !project.dependency(PLUGIN) &&
      injectUsers(project).length > 0,
    );
  },

  async check(project) {
    let babel = BABEL_CONFIGS.find((file) => project.has(file));

    if (babel) return { blockers: [], todo: [] };

    return {
      blockers: [
        {
          title: "No babel config for the undeprecate-inject plugin",
          action: "Run the ember-nvp stage first.",
        },
      ],
      todo: [],
    };
  },

  async run(project) {
    let users = injectUsers(project);
    let babel = /** @type {string} */ (BABEL_CONFIGS.find((file) => project.has(file)));
    let vite = /** @type {string} */ (viteConfig(project));
    /** @type {import('#types.js').Finding[]} */
    let todo = [];

    editPackageJson(project, (pkg) =>
      setDependency(pkg, PLUGIN, `^${published(PLUGIN)?.version ?? "1.0.7"}`),
    );

    let source = project.read(babel);

    if (source.includes("...macros.babelMacros")) {
      project.write(
        babel,
        source.replace(
          /^(\s*)\.\.\.macros\.babelMacros/m,
          `$1"${PLUGIN}",\n$1...macros.babelMacros`,
        ),
      );
    } else {
      todo.push({
        title: "Add the undeprecate-inject plugin to the babel config",
        where: [babel],
        action: `Add "${PLUGIN}" to \`plugins\`.`,
      });
    }

    let output = addBabelMatch(project.read(vite), vite);

    if (output) {
      project.write(vite, output);
    } else {
      todo.push({
        title: "Send the files that import `inject` to babel",
        where: [vite],
        action: `Add \`babel: { include: { whenMatching: [${WHEN_MATCHING}] } }\` to the options of ember().`,
      });
    }

    recordProgress(project, {
      id: "undeprecate-inject",
      status: "workaround",
      note:
        `${users.join(", ")} still import \`inject\` from @ember/service, which ember-source 7 removed. ` +
        `${PLUGIN} compiles those imports to \`service\`. Remove it, and the whenMatching pattern in ${vite}, ` +
        "when each dependency has a release that imports `service`.",
      links: [
        "https://deprecations.emberjs.com/id/importing-inject-from-ember-service",
        "https://github.com/NullVoxPopuli/undeprecate-inject-from-at-ember-service",
      ],
    });

    return todo;
  },
};
