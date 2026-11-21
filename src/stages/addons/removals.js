import { rmSync } from "node:fs";
import { join } from "node:path";
import { removeBuildOptions } from "#config-files.js";
import { dependencyNames, editPackageJson, removeDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#types.js').Finding} Finding */
/** @typedef {import('#progress.js').ProgressEntry} ProgressEntry */

/**
 * @typedef {object} Removal
 * @property {string} name
 * @property {string} label
 * @property {(name: string) => boolean} matches the packages to remove
 * @property {string[]} [buildOptions] the options in ember-cli-build that only these packages read
 * @property {string[]} [files] files that only these packages read
 * @property {Omit<ProgressEntry, "id" | "status">} [progress] work that the removal leaves open
 * @property {(project: import('#project.js').Project) => Finding[]} [todo]
 */

/**
 * @param {Removal} removal
 * @returns {import('#types.js').Stage}
 */
function removalStage(removal) {
  /**
   * @param {import('#project.js').Project} project
   */
  let packages = (project) => dependencyNames(project.packageJson).filter(removal.matches);

  return {
    name: removal.name,
    label: removal.label,

    detect(project) {
      return packages(project).length > 0;
    },

    async check(project) {
      return { blockers: [], todo: removal.todo?.(project) ?? [] };
    },

    async run(project) {
      let names = packages(project);
      let todo = removal.todo?.(project) ?? [];

      editPackageJson(project, (pkg) => {
        for (let name of names) removeDependency(pkg, name);
      });

      removeBuildOptions(project, removal.buildOptions ?? []);

      for (let file of removal.files ?? []) {
        rmSync(join(project.directory, file), { force: true });
      }

      if (removal.progress) {
        recordProgress(
          project,
          Object.assign({ id: removal.name, status: "removed" }, removal.progress),
        );
      }

      return todo;
    },
  };
}

/**
 * @param {import('#project.js').Project} project
 * @param {RegExp} pattern
 * @returns {string[]} the package.json scripts that match
 */
function scriptsMatching(project, pattern) {
  let scripts = /** @type {Record<string, string>} */ (project.packageJson.scripts ?? {});

  return Object.entries(scripts)
    .filter(([, command]) => pattern.test(command))
    .map(([name, command]) => `package.json scripts.${name}: ${command}`);
}

export const emberCliDeploy = removalStage({
  name: "ember-cli-deploy",
  label: "Remove ember-cli-deploy. It deploys ember-cli builds, and Vite writes the build to dist/",
  matches: (name) => name === "ember-cli-deploy" || name.startsWith("ember-cli-deploy-"),
  files: ["config/deploy.js"],
  progress: {
    note:
      "ember-cli-deploy and its plugins are removed. Deploy the dist/ folder that `vite build` writes. " +
      "For gzip and brotli files, use vite-plugin-compression2. For S3 uploads, use `aws s3 sync dist/`.",
    links: [
      "https://github.com/nonzzz/vite-plugin-compression",
      "https://vite.dev/guide/static-deploy",
    ],
  },
  todo(project) {
    let scripts = scriptsMatching(project, /\bember deploy\b/);

    if (scripts.length === 0) return [];

    return [
      {
        title: "Scripts that call `ember deploy`",
        where: scripts,
        action: "Change them to deploy the dist/ folder that `vite build` writes.",
      },
    ];
  },
});

export const emberCliAutoprefixer = removalStage({
  name: "ember-cli-autoprefixer",
  label: "Remove ember-cli-autoprefixer. Vite adds the vendor prefixes for the build targets",
  matches: (name) => name === "ember-cli-autoprefixer",
  buildOptions: ["autoprefixer"],
});

export const emberTestSelectors = removalStage({
  name: "ember-test-selectors",
  label: "Remove ember-test-selectors",
  matches: (name) => name === "ember-test-selectors",
  buildOptions: ["ember-test-selectors"],
});

/**
 * prember runs in the ember-cli build, so it does nothing in a Vite build.
 * vite-ember-ssr prerenders an app that builds without @embroider/compat,
 * so the progress file holds the work until the app gets there.
 */
export const prember = removalStage({
  name: "prember",
  label: "Remove prember. vite-ember-ssr prerenders the same URLs after the ember-nvp stage",
  matches: (name) => name === "prember",
  buildOptions: ["prember"],
  progress: {
    note:
      "prember is removed, because it does not run in a Vite build. " +
      "Prerender with emberSsg from vite-ember-ssr. It needs an app without @embroider/compat. " +
      "The URLs that prember used are still in the project, for example in prember-urls.js.",
    links: ["https://github.com/evoactivity/vite-ember-ssr#quick-start-ssg"],
  },
});

export const emberCliBundleAnalyzer = removalStage({
  name: "ember-cli-bundle-analyzer",
  label: "Remove ember-cli-bundle-analyzer. It analyzes ember-cli builds",
  matches: (name) => name === "ember-cli-bundle-analyzer",
  buildOptions: ["bundleAnalyzer"],
  progress: {
    note: "ember-cli-bundle-analyzer is removed. For the same report of a Vite build, add rollup-plugin-visualizer.",
    links: ["https://github.com/btd/rollup-plugin-visualizer"],
  },
});

export const emberCliDependencyLint = removalStage({
  name: "ember-cli-dependency-lint",
  label: "Remove ember-cli-dependency-lint. It is an ember-cli command",
  matches: (name) => name === "ember-cli-dependency-lint",
  files: ["config/dependency-lint.js"],
  todo(project) {
    let scripts = scriptsMatching(project, /\bember dependency-lint\b/);

    if (scripts.length === 0) return [];

    return [
      {
        title: "Scripts that call `ember dependency-lint`",
        where: scripts,
        action:
          "Remove them. A package manager with a strict dependency tree, such as pnpm, reports duplicate addons.",
      },
    ];
  },
});

export const emberDisablePrototypeExtensions = removalStage({
  name: "ember-disable-prototype-extensions",
  label:
    "Remove ember-disable-prototype-extensions. ember-source 5 removed the prototype extensions",
  matches: (name) => name === "ember-disable-prototype-extensions",
});

export const qunitConsoleGrouper = removalStage({
  name: "qunit-console-grouper",
  label: "Remove qunit-console-grouper. It adds a script to the ember-cli vendor.js",
  matches: (name) => name === "qunit-console-grouper",
  progress: {
    note:
      "qunit-console-grouper is removed. It grouped the console output of each test in the browser. " +
      "To keep that, copy its lib/qunit-console-grouper.js into tests/ and import it from tests/test-helper.",
    links: ["https://github.com/simplabs/qunit-console-grouper"],
  },
});
