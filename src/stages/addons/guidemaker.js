import { parseProgram, propertyName, walk } from "#ast.js";
import { addVitePlugin, buildFile, removeBuildOptions, viteConfig } from "#config-files.js";
import { editPackageJson, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";
import { atLeast } from "#version.js";

/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#ast.js').Node} Node */

const PR = "https://github.com/empress/guidemaker/pull/124";
/**
 * The built package of the PR branch, from a dist branch.
 */
const REF = "github:NullVoxPopuli-ai-agent/guidemaker#26f2d4a4a876f0ce3e95d2ea44790fcff87a8fe3";

/**
 * @param {Project} project
 * @returns {Node[]} the properties of the `guidemaker` option of ember-cli-build:
 * the ones of its object, and the ones that `x.name = value` assigns when the option is a variable `x`
 */
function buildOptions(project) {
  let file = buildFile(project);
  let program = file ? parseProgram(project.read(file), file) : undefined;

  if (!program) return [];

  /** @type {Node | undefined} */
  let value;

  walk(program, (node) => {
    if (node.type !== "Property" || propertyName(node) !== "guidemaker") return;

    value = node.value;
  });

  if (value?.type === "ObjectExpression") return value.properties;
  if (value?.type !== "Identifier") return [];

  let name = value.name;
  /** @type {Node[]} */
  let properties = [];

  walk(program, (node) => {
    if (node.type === "VariableDeclarator" && node.id?.name === name) {
      if (node.init?.type === "ObjectExpression")
        properties = properties.concat(node.init.properties);
    }

    let left = node.type === "AssignmentExpression" ? node.left : undefined;

    if (left?.type === "MemberExpression" && !left.computed && left.object?.name === name) {
      properties.push({
        type: "Property",
        start: node.start,
        end: node.end,
        key: left.property,
        value: node.right,
      });
    }
  });

  return properties;
}

/**
 * guidemaker 4 is a v1 addon, which built the content JSON with broccoli.
 * Its v2 branch has a Vite plugin in place of the broccoli hooks.
 *
 * @type {import('#types.js').Stage}
 */
export const guidemaker = {
  name: "guidemaker",
  label:
    "Install guidemaker as a v2 addon with its Vite plugin, from the branch of its open v2 pull request",

  detect(project) {
    let range = project.dependency("guidemaker");

    return (
      Boolean(range) &&
      !range?.includes(":") &&
      !atLeast(range, 5, 0) &&
      Boolean(project.dependency("@embroider/vite"))
    );
  },

  async check(project) {
    /** @type {import('#types.js').Finding[]} */
    let blockers = [];
    let source = buildOptions(project).find((property) => propertyName(property) === "source");

    if (!viteConfig(project)) {
      blockers.push({
        title: "The Vite config, where the guidemaker plugin goes",
        where: ["vite.config.mjs"],
        action: "Run the vite stage first.",
      });
    }

    if (source && !(source.value?.type === "Literal" && typeof source.value.value === "string")) {
      blockers.push({
        title: "A guidemaker `source` option that is not a string",
        where: [/** @type {string} */ (buildFile(project))],
        action: "Pass the source to `guidemaker({ source })` in the Vite config by hand.",
      });
    }

    return { blockers, todo: [] };
  },

  async run(project) {
    let release = published("guidemaker");
    let options = buildOptions(project);
    let source = options.find((property) => propertyName(property) === "source");
    let others = options
      .map((property) => propertyName(property))
      .filter((name) => name && name !== "source");

    editPackageJson(project, (pkg) => {
      setDependency(pkg, "guidemaker", release?.v2 ? `^${release.version}` : REF);

      if (!project.dependency("showdown")) setDependency(pkg, "showdown", "^2.1.0");
    });

    removeBuildOptions(project, ["guidemaker"]);

    addVitePlugin(project, {
      importLine: 'import { guidemaker } from "guidemaker/vite";',
      call: source
        ? `guidemaker({ source: ${JSON.stringify(source.value.value)} })`
        : "guidemaker()",
      specifier: "guidemaker/vite",
    });

    if (others.length > 0) {
      recordProgress(project, {
        id: "guidemaker: build options",
        status: "removed",
        note:
          `ember-cli-build passed ${others.map((name) => `\`${name}\``).join(", ")} to guidemaker, ` +
          "which the Vite plugin does not read. `premberVersionFilter` picks the prerendered versions: " +
          "pass it to `urls()` of `guidemaker/vite` when you set up the prerender.",
        links: [PR],
      });
    }

    /**
     * Replaces the entry of the v1-addons stage, which has the same id.
     */
    recordProgress(project, {
      id: "guidemaker",
      ...(release?.v2
        ? {
            status: "updated",
            note: `guidemaker ${release.version} is a v2 addon. Its Vite plugin builds the content JSON.`,
          }
        : {
            status: "git-ref",
            note:
              "guidemaker installs from the branch of its v2 pull request, because no release is a v2 addon. " +
              "Change it to the released version when the pull request is merged.",
            links: [PR],
          }),
    });

    return [];
  },
};
