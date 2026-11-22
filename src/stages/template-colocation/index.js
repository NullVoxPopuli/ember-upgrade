import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const FOLDER = "app/templates/components/";
const CLASS_EXTENSIONS = [".js", ".ts"];

/**
 * @param {Project} project
 * @param {string} template such as `app/templates/components/date-nav.hbs`
 * @returns {{ to: string, imported: string | undefined }} where the template goes, and a class that imports it as `layout`
 */
export function colocatedPath(project, template) {
  let name = template.slice(FOLDER.length, -".hbs".length);
  let index = CLASS_EXTENSIONS.map((extension) => `app/components/${name}/index${extension}`);
  let flat = CLASS_EXTENSIONS.map((extension) => `app/components/${name}${extension}`);
  let classFile = index.concat(flat).find((file) => project.has(file));
  let to = classFile?.includes("/index.")
    ? `app/components/${name}/index.hbs`
    : `app/components/${name}.hbs`;
  let imported =
    classFile && project.read(classFile).includes(`templates/components/${name}`)
      ? classFile
      : undefined;

  return { to, imported };
}

/**
 * Ember 6 removed components whose template ember-cli resolves from app/templates/components.
 * Each template moves next to its class, where @embroider/template-tag-codemod reads it.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "template-colocation",
  label: "Move component templates next to their classes",

  detect(project) {
    return project.files([`${FOLDER}**/*.hbs`]).some((file) => {
      let { to, imported } = colocatedPath(project, file);

      return !imported && !project.has(to);
    });
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    /** @type {import('#types.js').Finding[]} */
    let todo = [];
    /** @type {string[]} */
    let moved = [];

    for (let file of project.files([`${FOLDER}**/*.hbs`])) {
      let { to, imported } = colocatedPath(project, file);

      if (imported || project.has(to)) {
        todo.push({
          title: `Move ${file} next to its component`,
          where: [imported ?? to],
          action: imported
            ? "The class imports the template as its layout. Remove that import, then move the template."
            : `${to} exists already. Merge the two templates into it.`,
        });
        continue;
      }

      mkdirSync(dirname(join(project.directory, to)), { recursive: true });
      project.write(to, project.read(file));
      rmSync(join(project.directory, file));
      moved.push(`${file} to ${to}`);
    }

    if (moved.length > 0) {
      recordProgress(project, {
        id: "template-colocation",
        status: "changed",
        note: `Component templates are next to their classes now: ${moved.join(", ")}.`,
        links: ["https://deprecations.emberjs.com/id/component-template-resolving/"],
      });
    }

    return todo;
  },
};
