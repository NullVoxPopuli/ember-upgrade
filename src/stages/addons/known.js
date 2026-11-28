import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dependencyNames } from "#package-json.js";

/**
 * v1 addons that need no work from the addon stages.
 *
 * The lists come from ember-vite-codemod 1.9.0 (`lib/tasks/ensure-v2-addons.js`):
 * addons that Embroider supports as v1, addons that the codemod removes,
 * and addons that the codemod adds or updates.
 * The ember-nvp stage removes or replaces the ones that are left.
 */
export const IGNORED = new Set([
  "@ember/optional-features",
  "@embroider/macros",
  "@embroider/util",
  "@glimmer/tracking",
  "ember-auto-import",
  "ember-cli-babel",
  "ember-cli-htmlbars",
  "ember-template-imports",
  "ember-source",

  "@embroider/webpack",
  "broccoli-asset-rev",
  "ember-cli-app-version",
  "ember-cli-clean-css",
  "ember-cli-dependency-checker",
  "ember-cli-inject-live-reload",
  "ember-cli-sri",
  "ember-cli-terser",
  "loader.js",
  "webpack",

  "@babel/plugin-transform-runtime",
  "@ember/string",
  "@ember/test-helpers",
  "@embroider/compat",
  "@embroider/config-meta-loader",
  "@embroider/core",
  "@embroider/vite",
  "@embroider/legacy-inspector-support",
  "@rollup/plugin-babel",
  "babel-plugin-ember-template-compilation",
  "decorator-transforms",
  "ember-load-initializers",
  "ember-resolver",
  "ember-qunit",
  "vite",
]);

/**
 * v1 addons with no v2 release and no replacement yet.
 * The progress file links the work that a v2 release waits for.
 *
 * @type {Map<string, { note: string, links: string[] }>}
 */
export const NO_V2_YET = new Map([]);

/**
 * @param {Record<string, any>} manifest
 */
export function isV1Addon(manifest) {
  return (
    Boolean(manifest.keywords?.includes("ember-addon")) && manifest["ember-addon"]?.version !== 2
  );
}

/**
 * The v1 addons that the project installed, by name.
 *
 * @param {import('#project.js').Project} project
 * @returns {string[]}
 */
export function installedV1Addons(project) {
  /** @type {string[]} */
  let found = [];

  for (let name of dependencyNames(project.packageJson)) {
    let file = join(project.directory, "node_modules", name, "package.json");

    if (!existsSync(file)) continue;

    if (isV1Addon(JSON.parse(readFileSync(file, "utf8")))) found.push(name);
  }

  return found.sort();
}
