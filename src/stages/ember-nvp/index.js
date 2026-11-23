import { buildFile } from "#config-files.js";
import { install, packageManager, runUpstream } from "#process.js";
import { flatRulesOf, flatSettings, readEslintrc, withFlatSettings } from "./eslintrc.js";

/**
 * The layers that ember.nvp selects when `--layers` is not given.
 * `--layers` replaces them, so the stage lists them with the layers that it adds.
 */
const DEFAULT_LAYERS = ["agents-md", "inspector-support", "qunit", "readme"];

/**
 * The flat config that the eslint-bundled layer writes.
 */
const FLAT_CONFIG = "eslint.config.js";

/** @type {import('#types.js').Stage} */
export default {
  name: "ember-nvp",
  label: "Move to the ember.nvp layout (ember.nvp migration)",

  detect(project) {
    /**
     * ember.nvp apps build without @embroider/compat, so they have no ember-cli-build.
     */
    return Boolean(project.dependency("@embroider/vite")) && Boolean(buildFile(project));
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
    /**
     * Without a name, ember.nvp gives the app the name of its template, and imports of `<name>/...` stop resolving.
     */
    let args = [
      "--name",
      String(project.packageJson.name),
      "--path",
      project.directory,
      "--replaceOrUpdate",
      "update",
      "--type",
      "app",
      "--confirm",
      "yes",
    ];

    /**
     * Without it, ember.nvp writes pnpm scripts, also in an npm project.
     */
    let pm = packageManager(project);

    if (pm === "npm" || pm === "pnpm") args.push("--packageManager", pm);

    /**
     * The ember-source stages update ESLint to a version that does not read a legacy config.
     * ember.nvp removes the legacy config for the eslint-bundled layer, so the stage reads it first.
     */
    let eslintrc = readEslintrc(project);
    let layers = eslintrc ? DEFAULT_LAYERS.concat("eslint-bundled") : DEFAULT_LAYERS;

    for (let layer of layers) args.push("--layers", layer);

    if (!runUpstream(project, "ember.nvp@2.9.2", args)) {
      throw new Error("ember.nvp failed. Its output is above.");
    }

    if (!eslintrc || !project.has(FLAT_CONFIG)) return [];

    if (!install(project)) throw new Error("The install after ember.nvp failed.");

    let source = withFlatSettings(
      project.read(FLAT_CONFIG),
      flatSettings(eslintrc, await flatRulesOf(project, FLAT_CONFIG)),
    );

    if (source) project.write(FLAT_CONFIG, source);

    return [];
  },
};
