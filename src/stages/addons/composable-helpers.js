import { dirname, join } from "node:path";

import { parseProgram } from "#ast.js";
import { removeBuildOptions } from "#config-files.js";
import { Edits } from "#edits.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { Project } from "#project.js";
import { atLeast } from "#version.js";

/** @typedef {import('#ast.js').Node} Node */

const OLD = "ember-composable-helpers";
const NEW = "@nullvoxpopuli/ember-composable-helpers";
const FALLBACK = "5.3.2";
const POLYFILL = "ember-functions-as-helper-polyfill";
const POLYFILL_FALLBACK = "2.1.3";

const SOURCES = [
  "{app,addon,addon-test-support,tests,src}/**/*.{js,ts,gjs,gts}",
  "lib/*/{addon,app,addon-test-support}/**/*.{js,ts,gjs,gts}",
];

/**
 * Moves to the maintained v2 fork. The helper names and import paths stay the same.
 * ember-vite-codemod refuses the original, because of a Babel issue that will not be fixed.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ember-composable-helpers",
  label: `Move from ${OLD} to ${NEW}`,

  detect(project) {
    return Boolean(project.dependency(OLD));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let range = `^${published(NEW)?.version ?? FALLBACK}`;

    editPackageJson(project, (pkg) => {
      removeDependency(pkg, OLD);
      setDependency(pkg, NEW, range);

      /**
       * Functions as helpers are in ember-source 4.5 and later. The fork's helpers are plain functions.
       */
      if (!atLeast(project.dependency("ember-source"), 4, 5) && !project.dependency(POLYFILL)) {
        setDependency(pkg, POLYFILL, `^${published(POLYFILL)?.version ?? POLYFILL_FALLBACK}`);
      }
    });

    /**
     * In-repo addons and engines list the host's addons, often with "*".
     */
    for (let file of project.files(["lib/*/package.json"])) {
      let addon = new Project(join(project.directory, dirname(file)));

      editPackageJson(addon, (pkg) => {
        for (let section of ["dependencies", "devDependencies"]) {
          if (pkg[section]?.[OLD]) {
            let value = pkg[section][OLD];

            delete pkg[section][OLD];
            pkg[section][NEW] = value === "*" ? "*" : range;
          }
        }
      });
    }

    for (let file of project.files(SOURCES)) {
      let source = project.read(file);

      if (!source.includes(OLD)) continue;

      let output = renameImports(source, file);

      if (output !== source) project.write(file, output);
    }

    /**
     * The `only` and `except` options of the original. The fork is a v2 addon, so the build keeps only what the app uses.
     */
    removeBuildOptions(project, [OLD]);

    return [];
  },
};

/**
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
export function renameImports(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);

  for (let node of /** @type {Node[]} */ (program.body)) {
    let specifier = node.source;

    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      typeof specifier?.value === "string" &&
      (specifier.value === OLD || specifier.value.startsWith(`${OLD}/`))
    ) {
      let quote = source[specifier.start];

      edits.replace(specifier, `${quote}${NEW}${specifier.value.slice(OLD.length)}${quote}`);
    }
  }

  return edits.size > 0 ? edits.apply() : source;
}
