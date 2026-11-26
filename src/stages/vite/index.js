import { buildFile } from "#config-files.js";
import { addOverride } from "#manager-settings.js";
import { published, runUpstream } from "#process.js";
import { recordProgress } from "#progress.js";
import { atLeast } from "#version.js";
import { removeDeadTrees } from "./dead-trees.js";

/**
 * v1 addons depend on older copies of these packages, and the Vite build needs the latest one.
 * @embroider/macros keeps one shared config, so two copies of it break the build.
 * The versions are the fallback when the registry does not answer.
 */
const PINS = {
  "@ember/test-waiters": "4.1.2",
  "@embroider/macros": "1.21.4",
  "babel-plugin-ember-template-compilation": "4.0.1",
  /**
   * ember-element-helper before 0.5 adds a template plugin as a class,
   * which babel-plugin-ember-template-compilation 4 calls without `new`.
   */
  "ember-element-helper": "1.0.0",
};

const TSCONFIG = `{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": false,
    "noEmit": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "esnext"
  },
  "include": ["app/**/*", "tests/**/*", "types/**/*"]
}
`;

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
    /**
     * ember-vite-codemod treats the app as TypeScript when any .ts file is in the repo,
     * for example in another workspace package, and then crashes without a tsconfig.json.
     */
    if (!project.has("tsconfig.json") && project.files(["**/*.{ts,cts,mts,gts}"]).length > 0) {
      project.write("tsconfig.json", TSCONFIG);
      recordProgress(project, {
        id: "tsconfig.json",
        status: "added",
        note:
          "ember-upgrade added a small tsconfig.json, because ember-vite-codemod needs one when the repo has .ts files. " +
          "Keep it for editor support, or delete it if the app has no TypeScript.",
        links: ["https://github.com/mainmatter/ember-vite-codemod/issues/164"],
      });
    }

    if (!runUpstream(project, "ember-vite-codemod@1.9.0", ["--skip-git", "--skip-v2-addon"])) {
      throw new Error("ember-vite-codemod failed. Its output is above.");
    }

    /** @type {import('#types.js').Finding[]} */
    let todo = [];
    let file = buildFile(project);
    let build = file ? project.read(file) : "";
    let live = file ? removeDeadTrees(build, file) : build;

    if (file && live !== build) {
      project.write(file, live);
      todo.push({
        title: "ember-cli-build changed the output of the classic build, which Vite does not use",
        where: [file],
        action:
          "The code that post-processed `app.toTree()` is gone. If it did something that the app needs, such as PostCSS plugins, do it in the Vite config or in postcss.config.js.",
      });
    }

    for (let [name, fallback] of Object.entries(PINS)) {
      addOverride(project, name, `^${published(name)?.version ?? fallback}`);
    }

    for (let name of Object.keys(PINS)) {
      recordProgress(project, {
        id: name,
        status: "override",
        note:
          `An override forces the latest ${name} for all dependencies, because v1 addons depend on older versions. ` +
          "Remove the override when no dependency needs an older version.",
      });
    }

    return todo;
  },
};
