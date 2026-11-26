import { atLeast } from "#version.js";

const NAME = "ember-truth-helpers";
const FILES = ["{app,addon,tests,lib}/**/*.{js,ts,gjs,gts}"];

/**
 * ember-truth-helpers 5 named the modules of `eq` and `not-eq` after their helpers.
 */
const RENAMED = /(["'])ember-truth-helpers\/helpers\/(equal|not-equal)\1/g;

/**
 * @param {string} source
 * @returns {{ template: string, unreadable: string[] }}
 */
export function truthHelperPaths(source) {
  return {
    template: source.replace(
      RENAMED,
      (_, quote, name) => `${quote}${NAME}/helpers/${name === "equal" ? "eq" : "not-eq"}${quote}`,
    ),
    unreadable: [],
  };
}

/**
 * @param {import('#project.js').Project} project
 * @returns {string[]} the files that import the module paths of ember-truth-helpers before 5
 */
function oldPaths(project) {
  return project.files(FILES).filter((file) => {
    let source = project.read(file);

    return truthHelperPaths(source).template !== source;
  });
}

/**
 * An app that declares ember-truth-helpers 5 can still import its old module paths,
 * when an addon brought an older copy to the top of node_modules.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ember-truth-helpers-paths",
  label: "Import ember-truth-helpers 5 from its module paths",

  detect(project) {
    return atLeast(project.dependency(NAME), 5, 0) && oldPaths(project).length > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    for (let file of oldPaths(project)) {
      project.write(file, truthHelperPaths(project.read(file)).template);
    }

    return [];
  },
};
