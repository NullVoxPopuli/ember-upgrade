import { editPackageJson, removeDependency } from "#package-json.js";

const FEATURES = "config/optional-features.json";

/**
 * Code that uses jQuery: an import of it, `this.$()` of a classic component, or the `Ember.$` global.
 */
const USES_JQUERY = /from\s*["'](jquery|@ember\/jquery)["']|\bthis\.\$\(|\bEmber\.\$\b/;

/**
 * @param {import('#project.js').Project} project
 */
function enabled(project) {
  if (!project.has(FEATURES)) return false;

  return JSON.parse(project.read(FEATURES))["jquery-integration"] === true;
}

/**
 * @param {import('#project.js').Project} project
 * @returns {string[]} the files that use jQuery
 */
function users(project) {
  return project.files().filter((file) => USES_JQUERY.test(project.read(file)));
}

/**
 * Ember 4 removed the jQuery integration, and ember.nvp builds with Ember's default features.
 * The classic-component stage moved the components' jQuery calls to the DOM, so an app often uses none.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "jquery-integration",
  label: "Remove @ember/jquery, and turn off the jquery-integration feature",

  detect(project) {
    return enabled(project) || Boolean(project.dependency("@ember/jquery"));
  },

  async check(project) {
    let files = users(project);

    if (files.length === 0) return { blockers: [], todo: [] };

    return {
      blockers: [
        {
          title: "Code that uses jQuery",
          where: files,
          action:
            "Use the DOM API instead, or import jquery from npm where you still need it, and remove `this.$()`.",
        },
      ],
      todo: [],
    };
  },

  async run(project) {
    editPackageJson(project, (pkg) => removeDependency(pkg, "@ember/jquery"));

    if (enabled(project)) {
      let features = JSON.parse(project.read(FEATURES));

      features["jquery-integration"] = false;
      project.write(FEATURES, `${JSON.stringify(features, null, 2)}\n`);
    }

    return [];
  },
};
