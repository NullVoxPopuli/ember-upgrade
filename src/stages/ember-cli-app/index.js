import { buildFile, viteConfig } from "#config-files.js";

/**
 * The stages read and write an ember-cli project: ember-cli-build.js, app/, and config/.
 * A project that builds Ember with other tools, such as webpack, has none of them,
 * and the stages would write files that its build does not read. Addons have `ember-addon` in package.json.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ember-cli-app",
  label: "Check that the project builds with ember-cli or Vite",

  detect(project) {
    return (
      project.has("package.json") &&
      !buildFile(project) &&
      !viteConfig(project) &&
      !project.has("app") &&
      !project.packageJson["ember-addon"]
    );
  },

  async check() {
    return {
      blockers: [
        {
          title: "The project has no ember-cli-build.js, Vite config, or app/ folder",
          where: ["package.json"],
          action:
            "Run ember-upgrade in the folder of an ember-cli app. A project that builds Ember with other tools needs its own upgrade.",
        },
      ],
      todo: [],
    };
  },

  async run() {
    return [];
  },
};
