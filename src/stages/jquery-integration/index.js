import { rewriteJQuery } from "#codemods/classic-component/jquery.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";

const FEATURES = "config/optional-features.json";

/**
 * Code that needs the integration: `this.$()` of a classic component, the `Ember.$` global, or an import of `@ember/jquery`.
 * An import of the `jquery` package works without it.
 */
const USES_INTEGRATION = /from\s*["']@ember\/jquery["']|\bthis\.\$\(|\bEmber\.\$\b/;
const IMPORTS_JQUERY = /from\s*["']jquery["']/;
const COMPONENT_CODE = /\.(js|ts)$/;
const TEARDOWN = new Set(["willDestroyElement", "willClearRender"]);

/**
 * @param {import('#project.js').Project} project
 */
function enabled(project) {
  if (!project.has(FEATURES)) return false;

  return JSON.parse(project.read(FEATURES))["jquery-integration"] === true;
}

/**
 * @param {import('#project.js').Project} project
 * @returns {string[]} the files that need the jQuery integration
 */
function users(project) {
  return project.files().filter((file) => USES_INTEGRATION.test(project.read(file)));
}

/**
 * The classic components that the classic-components stage kept, such as subclasses of TextField,
 * whose jQuery calls the DOM API can replace.
 *
 * @param {import('#project.js').Project} project
 * @returns {Map<string, string>} the new source of each file
 */
function domRewrites(project) {
  /** @type {Map<string, string>} */
  let rewrites = new Map();

  for (let file of users(project)) {
    if (!COMPONENT_CODE.test(file)) continue;

    let result = rewriteJQuery(project.read(file), file, TEARDOWN);

    if (result.unreadable.length === 0 && !USES_INTEGRATION.test(result.source)) {
      rewrites.set(file, result.source);
    }
  }

  return rewrites;
}

/**
 * Ember 4 removed the jQuery integration, and ember.nvp builds with Ember's default features.
 * The classic-component stage moved the components' jQuery calls to the DOM, so an app often uses none.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "jquery-integration",
  label: "Remove @ember/jquery, and turn off the jquery-integration feature",

  detect(project) {
    return enabled(project) || Boolean(project.dependency("@ember/jquery"));
  },

  async check(project) {
    let rewrites = domRewrites(project);
    let files = users(project).filter((file) => !rewrites.has(file));

    if (files.length === 0) return { blockers: [], todo: [] };

    return {
      blockers: [
        {
          title: "Code that uses the jQuery integration",
          where: files,
          action:
            "Use the DOM API instead of `this.$()` and `Ember.$`, or import jquery from npm where you still need it.",
        },
      ],
      todo: [],
    };
  },

  async run(project) {
    for (let [file, source] of domRewrites(project)) project.write(file, source);

    let importsJquery = project.files().some((file) => IMPORTS_JQUERY.test(project.read(file)));

    editPackageJson(project, (pkg) => {
      removeDependency(pkg, "@ember/jquery");

      /**
       * @ember/jquery brought jquery. Code that imports it now needs its own dependency.
       */
      if (importsJquery && !pkg.dependencies?.jquery && !pkg.devDependencies?.jquery) {
        setDependency(pkg, "jquery", `^${published("jquery", "3")?.version ?? "3.7.1"}`);
      }
    });

    if (enabled(project)) {
      let features = JSON.parse(project.read(FEATURES));

      features["jquery-integration"] = false;
      project.write(FEATURES, `${JSON.stringify(features, null, 2)}\n`);
    }

    return [];
  },
};
