import { join } from "node:path";
import { runUpstream } from "#process.js";
import { addonComponents, replaceShims, writeShims } from "./addon-components.js";
import { fixImports } from "./fix-imports.js";
import { removeStaleTemplates } from "./stale-templates.js";
import { recordProgress } from "#progress.js";
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
      /**
       * The components of inlined v1 addons that the app extends stay in app/addons/<addon>.
       */
      "--components",
      "app/components/**/*.{js,ts,hbs}",
      "app/addons/**/components/**/*.{js,ts,hbs}",
    ];

    let stale = removeStaleTemplates(project);

    if (stale.length > 0) {
      recordProgress(project, {
        id: "stale templates",
        status: "removed",
        note:
          "These .hbs files had a .gjs or .gts file of the same name with its own <template>, which the component uses: " +
          `${stale.join(", ")}. Check that the <template> has what the .hbs file had.`,
      });
    }

    let components = addonComponents(project);

    writeShims(project, components);

    if (!runUpstream(project, "@embroider/template-tag-codemod@1.4.2", args)) {
      throw new Error("@embroider/template-tag-codemod failed. Its output is above.");
    }

    replaceShims(project, components);

    for (let file of project.files(["{app,tests}/**/*.{js,ts,gjs,gts}"])) {
      let source = project.read(file);
      let fixed = fixImports(source, join(project.directory, file));

      if (fixed !== source) project.write(file, fixed);
    }

    return [];
  },
};
