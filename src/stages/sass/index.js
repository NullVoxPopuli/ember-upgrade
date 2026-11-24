import { parseProgram, propertyName, walk } from "#ast.js";
import { viteConfig } from "#config-files.js";
import { Edits } from "#edits.js";
import { runUpstream } from "#process.js";
import { readProgress, recordProgress } from "#progress.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('#project.js').Project} Project */

const PROGRESS_ID = "sass-deprecations";
const MIGRATOR = "sass-migrator@2.7.0";

/**
 * The migrations that keep `@import`, so that they also work in an app whose libraries are not Sass modules.
 */
const MIGRATIONS = ["division", "color"];

/**
 * `darken($c, 5)` lightened by 5%. The color migration writes `$lightness: -5`, and Sass deprecates the number
 * without its unit (function-units).
 */
const UNITLESS = /(\$(?:lightness|saturation):\s*-?)(\d+(?:\.\d+)?)(?![\d.%a-z])/g;

/**
 * @param {string} source
 * @returns {string}
 */
export function withPercentUnits(source) {
  return source.replace(UNITLESS, "$1$2%");
}

/**
 * Sass does not report the deprecations of stylesheets that come from dependencies, which the app cannot change.
 *
 * @param {string} source the Vite config
 * @param {string} file
 * @returns {string | undefined} undefined when the config has no object for defineConfig, or already sets `css`
 */
export function withQuietDeps(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  /** @type {Node | undefined} */
  let config;

  walk(program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "defineConfig" &&
      node.arguments[0]?.type === "ObjectExpression"
    ) {
      config = node.arguments[0];
    }
  });

  if (!config) return;
  if (config.properties.some((/** @type {Node} */ p) => propertyName(p) === "css")) return;

  let property = "css: { preprocessorOptions: { scss: { quietDeps: true } } }";
  let last = config.properties[config.properties.length - 1];
  let edits = new Edits(source);

  if (!last) {
    edits.replace(config, `{ ${property} }`);
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
 * @param {Project} project
 * @returns {string[]} the stylesheets that the app loads, not the partials that they import
 */
function entryStylesheets(project) {
  return project
    .files(["app/styles/**/*.scss"])
    .filter((file) => !(file.split("/").pop() ?? "").startsWith("_"));
}

/**
 * Sass logs deprecations for `/` division, the global color functions, and stylesheets of dependencies.
 * sass-migrator rewrites the app's own stylesheets, and the CSS that they compile to stays the same.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "sass",
  label:
    "Resolve the Sass deprecations: division, color functions, and the warnings of dependencies",
  needsInstall: true,

  detect(project) {
    if (!project.dependency("sass") || entryStylesheets(project).length === 0) return false;

    return !readProgress(project).some((entry) => entry.id === PROGRESS_ID);
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let entries = entryStylesheets(project);
    /** @type {string[]} */
    let failed = [];

    /**
     * Each migration runs on its own: the migrator reads the second name as a stylesheet.
     * The stylesheets that the entries import are migrated too. Those of load paths, such as node_modules, are not.
     */
    for (let migration of MIGRATIONS) {
      let args = [
        migration,
        "--migrate-deps",
        "--load-path=node_modules",
        "--load-path=app/styles",
      ];

      if (!runUpstream(project, MIGRATOR, args.concat(entries))) failed.push(migration);
    }

    for (let file of project.files(["app/styles/**/*.scss"])) {
      let source = project.read(file);
      let output = withPercentUnits(source);

      if (output !== source) project.write(file, output);
    }

    let vite = viteConfig(project);
    let quiet = vite ? withQuietDeps(project.read(vite), vite) : undefined;

    if (vite && quiet) project.write(vite, quiet);

    let imports = project
      .files(["app/styles/**/*.scss"])
      .filter((file) => /^\s*@import\s/m.test(project.read(file)));

    let notes = [];

    if (failed.length > 0) {
      notes.push(
        `The ${failed.join(" and ")} migration of sass-migrator failed. Its output is above.`,
      );
    }

    if (!quiet) {
      notes.push(
        "Set `css.preprocessorOptions.scss.quietDeps` to true in the Vite config, so that Sass does not report the deprecations of dependencies.",
      );
    }

    if (imports.length > 0) {
      notes.push(
        `These stylesheets still use @import, which Sass deprecates: ${imports.join(", ")}. ` +
          "`npx sass-migrator module --migrate-deps` moves them to @use, " +
          "after the libraries that they import, such as bourbon, are Sass modules or are gone.",
      );
    }

    recordProgress(project, {
      id: PROGRESS_ID,
      status: notes.length > 0 ? "todo" : "done",
      note:
        notes.join(" ") ||
        "sass-migrator rewrote the division and color functions, and Sass does not report the deprecations of dependencies.",
      links: ["https://sass-lang.com/documentation/cli/migrator/"],
    });

    return [];
  },
};
