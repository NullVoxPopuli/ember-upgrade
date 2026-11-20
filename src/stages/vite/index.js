import { buildFile } from "#config-files.js";
import { addOverride, editPackageJson } from "#package-json.js";
import { packageManager, published, runUpstream } from "#process.js";
import { recordProgress } from "#progress.js";
import { atLeast } from "#version.js";

/**
 * v1 addons depend on older copies of these packages, and the Vite build needs the latest one.
 * The versions are the fallback when the registry does not answer.
 */
const PINS = {
  "@ember/test-waiters": "4.1.2",
  "babel-plugin-ember-template-compilation": "4.0.1",
};

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

    let pm = packageManager(project);

    editPackageJson(project, (pkg) => {
      for (let [name, fallback] of Object.entries(PINS)) {
        addOverride(pkg, pm, name, `^${published(name)?.version ?? fallback}`);
      }
    });

    for (let name of Object.keys(PINS)) {
      recordProgress(project, {
        id: name,
        status: "override",
        note:
          `package.json forces the latest ${name} for all dependencies, because v1 addons depend on older versions. ` +
          "Remove the override when no dependency needs an older version.",
      });
    }

    return [];
  },
};
