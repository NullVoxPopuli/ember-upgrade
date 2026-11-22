import { buildFile } from "#config-files.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";
import { minorOf } from "#version.js";

/**
 * `require('node-sass')` and `require("node-sass")`, as an ember-cli-build passes it to `sassOptions.implementation`.
 */
const NODE_SASS = /require\(\s*(["'])node-sass\1\s*\)/g;

/**
 * @param {import('#project.js').Project} project
 * @returns {boolean} ember-cli-sass is older than 10, which compiled with node-sass
 */
function oldEmberCliSass(project) {
  let range = project.dependency("ember-cli-sass");
  let major = range ? minorOf(range)?.[0] : undefined;

  return major !== undefined && major < 10;
}

/**
 * node-sass does not build for Node 18 and later, so an ember-cli build that loads it cannot start.
 * ember-cli-sass 10 and later compile with sass (Dart Sass) by default.
 * @embroider/template-tag-codemod boots the ember-cli build, so the stage runs before it.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ember-cli-sass",
  label: "Compile Sass with sass (Dart Sass), not node-sass",

  detect(project) {
    return oldEmberCliSass(project) || Boolean(project.dependency("node-sass"));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    editPackageJson(project, (pkg) => {
      removeDependency(pkg, "node-sass");
      setDependency(pkg, "sass", `^${published("sass")?.version ?? "1.94.2"}`);

      if (oldEmberCliSass(project)) {
        setDependency(
          pkg,
          "ember-cli-sass",
          `^${published("ember-cli-sass")?.version ?? "11.0.1"}`,
        );
      }
    });

    let file = buildFile(project);

    if (file && project.read(file).match(NODE_SASS)) {
      project.write(file, project.read(file).replace(NODE_SASS, "require($1sass$1)"));
    }

    recordProgress(project, {
      id: "ember-cli-sass",
      status: "changed",
      note:
        "Sass compiles with sass (Dart Sass) now, because node-sass does not build for current Node versions. " +
        "Dart Sass deprecates some Sass features, such as `/` for division. Check the build output for warnings.",
      links: ["https://sass-lang.com/documentation/breaking-changes/"],
    });

    return [];
  },
};
