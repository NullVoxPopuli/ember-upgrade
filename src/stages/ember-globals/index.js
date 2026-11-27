import { transform } from "./transform.js";

/**
 * A quick text match. Only files that match get parsed.
 */
const EMBER_IMPORT = /import\s+[\w$]+\s*(,\s*\{[^}]*\})?\s*from\s*["']ember["']/;

/**
 * @param {import('#project.js').Project} project
 * @returns {string[]}
 */
function filesWithGlobals(project) {
  return project.sourceFiles().filter((file) => EMBER_IMPORT.test(project.read(file)));
}

/** @type {import('#types.js').Stage} */
const emberGlobals = {
  name: "ember-globals",
  label: "Replace `Ember.*` globals with `@ember/*` imports (RFC 176)",

  detect(project) {
    return filesWithGlobals(project).some((file) => {
      let source = project.read(file);

      return transform(source, file).code !== source;
    });
  },

  async check(project) {
    /** @type {import('#types.js').Finding[]} */
    let todo = [];

    for (let file of filesWithGlobals(project)) {
      for (let item of transform(project.read(file), file).todo) todo.push(item);
    }

    return { blockers: [], todo };
  },

  async run(project) {
    /** @type {import('#types.js').Finding[]} */
    let todo = [];

    for (let file of filesWithGlobals(project)) {
      let source = project.read(file);
      let result = transform(source, file);

      if (result.code !== source) project.write(file, result.code);

      for (let item of result.todo) todo.push(item);
    }

    return todo;
  },
};

/**
 * The same changes for the code of the v1 addons that the v2-addons stage copied into the app.
 *
 * @type {import('#types.js').Stage}
 */
export const emberGlobalsInlined = Object.assign({}, emberGlobals, {
  name: "ember-globals-inlined",
  label: "Replace `Ember.*` globals with `@ember/*` imports in the code of the inlined addons",
});

export default emberGlobals;
