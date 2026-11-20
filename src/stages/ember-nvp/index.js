import { runUpstream } from "#process.js";

const BUILD_FILES = ["ember-cli-build.js", "ember-cli-build.cjs"];

/** @type {import('#types.js').Stage} */
export default {
  name: "ember-nvp",
  label: "Move to the ember.nvp layout (ember.nvp migration)",

  detect(project) {
    /**
     * ember.nvp apps build without @embroider/compat, so they have no ember-cli-build.
     */
    return (
      Boolean(project.dependency("@embroider/vite")) &&
      BUILD_FILES.some((file) => project.has(file))
    );
  },

  async check(project) {
    /** @type {import('#types.js').Report} */
    let report = { blockers: [], todo: [] };
    let hbs = project.files(["app/**/*.hbs"]);

    if (hbs.length > 0) {
      report.blockers.push({
        title: "Templates in .hbs files",
        where: hbs,
        action: "Run the template-tag stage first. ember.nvp apps build without @embroider/compat.",
      });
    }

    return report;
  },

  async run(project) {
    let args = [
      "--path",
      project.directory,
      "--replaceOrUpdate",
      "update",
      "--type",
      "app",
      "--confirm",
      "yes",
    ];

    if (!runUpstream(project, "ember.nvp@2.4.0", args)) {
      throw new Error("ember.nvp failed. Its output is above.");
    }

    return [];
  },
};
