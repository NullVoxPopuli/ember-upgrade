import { runUpstream } from "#process.js";
import { readProgress, recordProgress } from "#progress.js";

const TEMPLATES = ["app/templates/components/**/*.hbs"];

/**
 * Ember 6 removed components whose template ember-cli resolves from app/templates/components,
 * and @embroider/template-tag-codemod stops at them.
 * ember-component-template-colocation-migrator moves each template next to its class.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "template-colocation",
  label:
    "Move component templates next to their classes (ember-component-template-colocation-migrator)",

  detect(project) {
    /**
     * The migrator leaves templates that it cannot move, so the progress entry shows that it ran.
     */
    if (readProgress(project).some((entry) => entry.id === "template-colocation")) return false;

    return project.files(TEMPLATES).length > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    if (!runUpstream(project, "ember-component-template-colocation-migrator@1.2.0", [])) {
      throw new Error("ember-component-template-colocation-migrator failed. Its output is above.");
    }

    let left = project.files(TEMPLATES);

    recordProgress(project, {
      id: "template-colocation",
      status: "changed",
      note: "Component templates are next to their classes now.",
      links: ["https://deprecations.emberjs.com/id/component-template-resolving/"],
    });

    return left.length > 0
      ? [
          {
            title: "Component templates that the migrator did not move",
            where: left,
            action:
              "Move each one next to its class. A template that several classes use, or that a class imports as `layout`, needs a class of its own.",
          },
        ]
      : [];
  },
};
