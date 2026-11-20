import { buildFile } from "#config-files.js";
import { runUpstream } from "#process.js";
import { atLeast } from "#version.js";

/** @type {import('#types.js').Stage} */
export default {
  name: "vite",
  label: "Build with Vite (ember-vite-codemod)",
  needsInstall: true,

  detect(project) {
    return Boolean(buildFile(project)) && !project.dependency("@embroider/vite");
  },

  async check(project) {
    /** @type {import('#types.js').Report} */
    let report = { blockers: [], todo: [] };
    let emberSource = project.dependency("ember-source");

    if (!atLeast(emberSource, 3, 28)) {
      report.blockers.push({
        title: `ember-source ${emberSource ?? "(missing)"} is older than 3.28`,
        where: ["package.json"],
        action: "Upgrade ember-source to 3.28 or newer, then run ember-upgrade again.",
      });
    }

    return report;
  },

  async run(project) {
    /**
     * The runner checks git and commits after each stage.
     * Embroider keeps v1 addons working, and the addon stages after this one update them, one commit for each.
     */
    if (!runUpstream(project, "ember-vite-codemod@1.9.0", ["--skip-git", "--skip-v2-addon"])) {
      throw new Error("ember-vite-codemod failed. Its output is above.");
    }

    return [];
  },
};
