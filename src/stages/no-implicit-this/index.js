import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dependencyNames } from "#package-json.js";
import { readProgress, recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const CODEMOD = "ember-no-implicit-this-codemod@3.0.0";
const CONFIG = ".no-implicit-this.json";
const FILES = ["tests/**/*.{js,ts}", "app/**/*.hbs"];
const INVOKABLES = "{components,helpers}/**/*.{js,ts,gjs,gts,hbs}";

/**
 * @param {string} file such as `components/x-select/index.js`
 * @returns {string} the name that a template invokes, such as `x-select`
 */
export function invokableName(file) {
  return file
    .replace(/^(components|helpers)\//, "")
    .replace(/\.\w+$/, "")
    .replace(/\/(index|component|template)$/, "");
}

/**
 * The components and helpers of the app and of its addons' app trees.
 * The codemod reads them from a running app, and this list replaces that.
 *
 * @param {Project} project
 * @returns {string[]}
 */
export function invokables(project) {
  /** @type {Set<string>} */
  let names = new Set();
  /** @type {string[]} */
  let folders = [join(project.directory, "app")];

  for (let name of dependencyNames(project.packageJson)) {
    let directory = join(project.directory, "node_modules", name);
    let manifest = join(directory, "package.json");

    if (!existsSync(manifest)) continue;

    let appJs = JSON.parse(readFileSync(manifest, "utf8"))["ember-addon"]?.["app-js"];

    for (let file of Object.keys(appJs ?? {})) {
      let path = file.replace(/^\.\//, "");

      if (/^(components|helpers)\//.test(path)) names.add(invokableName(path));
    }

    folders.push(join(directory, "app"));
  }

  for (let folder of folders) {
    if (!existsSync(folder)) continue;

    for (let file of globSync(INVOKABLES, { cwd: folder })) {
      names.add(invokableName(file.split("\\").join("/")));
    }
  }

  return Array.from(names).sort();
}

/**
 * Ember 4 removed the fallback from `{{name}}` to `{{this.name}}`. App templates broke at once,
 * but test templates in `hbs` strings break only when they run, and @embroider/template-tag-codemod
 * reads `{{name}}` as a helper that does not exist.
 * ember-no-implicit-this-codemod adds `this.`, with the app's components and helpers left as they are.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "no-implicit-this",
  label: "Add `this.` to template properties (ember-no-implicit-this-codemod)",

  detect(project) {
    if (readProgress(project).some((entry) => entry.id === "no-implicit-this")) return false;

    return project
      .files(["tests/**/*.{js,ts}"])
      .some((file) => project.read(file).includes("hbs`"));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let install = mkdtempSync(join(tmpdir(), "no-implicit-this-"));

    try {
      let installed = spawnSync(
        "npm",
        [
          "install",
          "--prefix",
          install,
          CODEMOD,
          "--no-save",
          "--no-audit",
          "--no-fund",
          "--silent",
        ],
        { stdio: "inherit", shell: process.platform === "win32" },
      );

      if (installed.status !== 0) throw new Error(`npm could not install ${CODEMOD}.`);

      /**
       * The codemod reads the config relative to the current folder.
       */
      writeFileSync(
        join(project.directory, CONFIG),
        JSON.stringify({ helpers: invokables(project) }),
      );

      let modules = join(install, "node_modules");
      let files = project.files(FILES);

      /**
       * jscodeshift, not codemod-cli, because codemod-cli does not pass `--no-babel`.
       * With Babel, jscodeshift compiles the transform with the app's babel.config.mjs,
       * which is async, and every file fails.
       */
      let result = spawnSync(
        process.execPath,
        [
          join(modules, "jscodeshift/bin/jscodeshift.js"),
          "--no-babel",
          "--extensions=js,ts,hbs",
          "-t",
          join(modules, "ember-no-implicit-this-codemod/transforms/no-implicit-this/index.js"),
        ].concat(files),
        {
          cwd: project.directory,
          encoding: "utf8",
          env: Object.assign({}, process.env, {
            CODEMOD_CLI_ARGS: JSON.stringify({ config: CONFIG }),
          }),
        },
      );
      let output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      process.stdout.write(output);

      /**
       * jscodeshift exits with 0 when a file fails, so the summary shows the failures.
       */
      let errors = Number(/(\d+) errors?/.exec(output.replace(/\x1b\[[0-9;]*m/g, ""))?.[1] ?? 0);

      if (result.status !== 0 || errors > 0) {
        throw new Error(`${CODEMOD} failed on ${errors} files. Its output is above.`);
      }
    } finally {
      rmSync(join(project.directory, CONFIG), { force: true });
      rmSync(install, { recursive: true, force: true });
    }

    recordProgress(project, {
      id: "no-implicit-this",
      status: "changed",
      note:
        "Templates read the properties of the test context or the component as `this.name` now, not `name`. " +
        "The codemod left the app's and the addons' components and helpers as they are.",
      links: ["https://github.com/ember-codemods/ember-no-implicit-this-codemod"],
    });

    return [];
  },
};
