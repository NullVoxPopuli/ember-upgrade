import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolvePackage } from "#installed.js";

/** @typedef {import('#project.js').Project} Project */

const FILES = ["app/**/*.{js,ts,gjs,gts}"];
const CSS_IMPORT = /(import\s+)(['"])((?:@[^/'"]+\/)?[^./'"][^'"]*\.css)\2/g;

/**
 * @param {unknown} target
 * @returns {string | undefined}
 */
function targetFile(target) {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object") return;

  let conditions = /** @type {Record<string, unknown>} */ (target);

  return targetFile(conditions.style ?? conditions.import ?? conditions.default);
}

/**
 * @param {Record<string, any>} exports
 * @param {string} subpath such as `./styles.css`
 * @returns {string | undefined} the file of the package that the subpath reaches
 */
function resolveExport(exports, subpath) {
  for (let [key, target] of Object.entries(exports)) {
    let path = targetFile(target);

    if (!path) continue;
    if (key === subpath) return path;

    let star = key.indexOf("*");

    if (star === -1) continue;

    let prefix = key.slice(0, star);
    let suffix = key.slice(star + 1);

    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= prefix.length + suffix.length
    ) {
      return path.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
}

/**
 * @param {Record<string, any>} exports
 * @param {string} file a file of the package, such as `./dist/styles/x.css`
 * @returns {string | undefined} a subpath that reaches the file, such as `./styles/x.css`
 */
function exportFor(exports, file) {
  for (let [key, target] of Object.entries(exports)) {
    let path = targetFile(target);

    if (!path) continue;
    if (path === file) return key;

    let star = path.indexOf("*");

    if (star === -1 || !key.includes("*")) continue;

    let prefix = path.slice(0, star);
    let suffix = path.slice(star + 1);

    if (file.startsWith(prefix) && file.endsWith(suffix)) {
      return key.replace("*", file.slice(prefix.length, file.length - suffix.length));
    }
  }
}

/**
 * @param {string} specifier such as `ember-a11y-refocus/styles.css`
 * @param {string} from the app's folder
 * @returns {string | undefined} the specifier of the package's one stylesheet, when the import reaches no file
 */
export function stylesheetOf(specifier, from) {
  let parts = specifier.split("/");
  let name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : String(parts[0]);
  let directory = resolvePackage(from, name);

  if (!directory) return;

  let manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  let subpath = `.${specifier.slice(name.length)}`;
  let exports =
    manifest.exports && typeof manifest.exports === "object" ? manifest.exports : undefined;
  let reached = exports ? resolveExport(exports, subpath) : subpath;

  if (reached && existsSync(join(directory, reached))) return;

  let stylesheets = globSync("**/*.css", {
    cwd: directory,
    exclude: (path) => path === "node_modules",
  });

  if (stylesheets.length !== 1) return;

  let file = `./${String(stylesheets[0]).split("\\").join("/")}`;
  let exported = exports ? exportFor(exports, file) : file;

  return exported ? `${name}${exported.slice(1)}` : undefined;
}

/**
 * The compat build let an app import a stylesheet of a package by a path that the package does not have.
 * The Vite build of ember.nvp resolves each import, so the import names the package's one stylesheet.
 *
 * @param {Project} project
 * @returns {string[]} the imports that changed, as `file: old -> new`
 */
export function fixStylesheetImports(project) {
  /** @type {string[]} */
  let changed = [];

  for (let file of project.files(FILES)) {
    let source = project.read(file);

    if (!source.includes(".css")) continue;

    let output = source.replace(CSS_IMPORT, (all, keyword, quote, specifier) => {
      let stylesheet = stylesheetOf(specifier, project.directory);

      if (!stylesheet) return all;

      changed.push(`${file}: ${specifier} -> ${stylesheet}`);

      return `${keyword}${quote}${stylesheet}${quote}`;
    });

    if (output !== source) project.write(file, output);
  }

  return changed;
}
