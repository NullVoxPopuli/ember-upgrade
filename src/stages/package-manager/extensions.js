/**
 * Old addons that require a package without listing it.
 * yarn 1 and npm 6 hoisted a copy that worked, but pnpm gives them the copy that other packages asked for.
 * Each entry adds the dependency, at the version that the addon was written for.
 *
 * Add an entry when a trial app shows a new one.
 * pnpm also has its own list, from @yarnpkg/extensions, so check that first.
 *
 * @type {Record<string, Record<string, string>>}
 */
export const PACKAGE_EXTENSIONS = {
  /**
   * snippet-finder.js calls `Plugin.call(this)`, which only works with broccoli-plugin 1.
   */
  "ember-code-snippet@<3": { "broccoli-plugin": "^1.3.1" },
};

/**
 * Addons that read a package from the app's node_modules, so the app must list it.
 * The stage adds each one at the version that yarn 1 or npm 6 hoisted.
 *
 * @type {Record<string, string[]>}
 */
export const APP_DEPENDENCIES = {
  /**
   * The addon docs tell apps to install the svg core next to the addon.
   */
  "@fortawesome/ember-fontawesome": ["@fortawesome/fontawesome-svg-core"],
};
