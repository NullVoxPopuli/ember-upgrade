import { runUpstream } from "#process.js";
import { atLeast } from "#version.js";

/** @type {import('#types.js').Stage} */
export default {
  name: "template-tag",
  label: "Convert templates to <template> tag (@embroider/template-tag-codemod)",
  needsInstall: true,

  detect(project) {
    /**
     * The codemod resolves template invocations through the Embroider build,
     * so it runs only after the vite stage.
     */
    if (!project.dependency("@embroider/vite")) return false;

    return project.files(["app/**/*.hbs"]).length > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let emberSource = project.dependency("ember-source");
    let args = [
      "--nativeRouteTemplates",
      String(atLeast(emberSource, 6, 3)),
      "--nativeLexicalThis",
      String(atLeast(emberSource, 6, 4)),
    ];

    if (!runUpstream(project, "@embroider/template-tag-codemod@1.4.2", args)) {
      throw new Error("@embroider/template-tag-codemod failed. Its output is above.");
    }

    return [];
  },
};
