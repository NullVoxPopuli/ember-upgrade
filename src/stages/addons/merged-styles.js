import { existsSync, globSync } from "node:fs";
import { join } from "node:path";

import { resolvePackage } from "#installed.js";
import { sassName } from "#stages/vite-sass/index.js";

/** @typedef {import('#project.js').Project} Project */

const STYLES = ["app/styles/**/*.{scss,sass}"];
const IMPORT = /(@(?:import|use|forward)\s+)(["'])([^"']+)\2/g;

/**
 * @param {string} folder
 * @returns {string[]} the stylesheets under the folder, relative to it
 */
function stylesheets(folder) {
  if (!existsSync(folder)) return [];

  return globSync("**/*.{scss,sass,css}", {
    cwd: folder,
    exclude: (name) => name === "node_modules",
  }).map((file) => file.split("\\").join("/"));
}

/**
 * ember-cli merged the `app/styles` of a v1 addon into the app's styles, so the app imported them by their path there.
 *
 * @param {Project} project
 * @param {string} name the installed v1 addon
 * @returns {Map<string, string>} each import of the app that reached the addon's `app/styles`, and the file there
 */
export function mergedStyleImports(project, name) {
  let directory = resolvePackage(project.directory, name);
  /** @type {Map<string, string>} */
  let found = new Map();

  if (!directory) return found;

  let files = new Map(
    stylesheets(join(directory, "app/styles")).map((file) => [sassName(file), file]),
  );

  if (files.size === 0) return found;

  let own = new Set(stylesheets(join(project.directory, "app/styles")).map(sassName));

  for (let file of project.files(STYLES)) {
    for (let match of project.read(file).matchAll(IMPORT)) {
      let specifier = String(match[3]);
      let merged = files.get(specifier);

      if (merged && !own.has(specifier)) {
        found.set(specifier, merged);
      }
    }
  }

  return found;
}

/**
 * Points the imports of the merged styles at the same files in the installed v2 addon.
 * Sass finds `node_modules/...` from the app's folder in the classic build, and the vite-sass stage turns it into a package path.
 *
 * @param {Project} project
 * @param {string} name the installed v2 addon
 * @param {Map<string, string>} imports from {@link mergedStyleImports}
 * @returns {string[]} the imports with no such file in the v2 addon
 */
export function moveMergedStyleImports(project, name, imports) {
  let directory = resolvePackage(project.directory, name);
  let files = directory ? stylesheets(directory) : [];
  /** @type {Map<string, string>} */
  let moved = new Map();
  /** @type {string[]} */
  let missing = [];

  for (let [specifier, merged] of imports) {
    let match = files
      .filter((file) => file === merged || file.endsWith(`/${merged}`))
      .sort((a, b) => a.length - b.length)[0];

    if (match) moved.set(specifier, `node_modules/${name}/${sassName(match)}`);
    else missing.push(specifier);
  }

  for (let file of project.files(STYLES)) {
    let source = project.read(file);
    let output = source.replace(IMPORT, (all, keyword, quote, specifier) => {
      let path = moved.get(specifier);

      return path ? `${keyword}${quote}${path}${quote}` : all;
    });

    if (output !== source) project.write(file, output);
  }

  return missing;
}
