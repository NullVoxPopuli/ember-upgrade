import { editPackageJson, setDependency } from "#package-json.js";
import { atLeast } from "#version.js";

/**
 * ember-vite-codemod needs ember-cli 4.12. ember-cli versions do not depend on the ember-source version.
 */
const TARGET = "~4.12.3";

/**
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ember-cli",
  label: "Update ember-cli to 4.12",

  detect(project) {
    let range = project.dependency("ember-cli");

    return Boolean(range) && !atLeast(range, 4, 12);
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    editPackageJson(project, (pkg) => setDependency(pkg, "ember-cli", TARGET));

    return [];
  },
};
