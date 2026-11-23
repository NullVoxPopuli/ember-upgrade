import { rmSync } from "node:fs";
import { join } from "node:path";
import { removeBuildOptions } from "#config-files.js";
import {
  dependencyNames,
  editPackageJson,
  removeDependency,
  setDependency,
} from "#package-json.js";
import { published } from "#process.js";
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
 * @property {Record<string, string>} [replaceWith] packages that the app imports instead, with a fallback version, such as the library that a shim addon wrapped
 * @property {Omit<ProgressEntry, "id" | "status">} [progress] work that the removal leaves open
 * @property {(project: import('#project.js').Project) => Finding[]} [todo]
 * @property {(project: import('#project.js').Project) => void} [after] changes the app after the removal
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

        for (let [name, fallback] of Object.entries(removal.replaceWith ?? {})) {
          if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) continue;

          setDependency(pkg, name, `^${published(name)?.version ?? fallback}`);
        }
      });

      removeBuildOptions(project, removal.buildOptions ?? []);

      for (let file of removal.files ?? []) {
        rmSync(join(project.directory, file), { force: true });
      }

      removal.after?.(project);

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

/**
 * Build tools that Vite replaces, and polyfills and shims for what Ember 6 and Vite do on their own.
 * Each one has no v2 release, so the v2-addons stage cannot update it.
 *
 * @type {(Omit<Removal, "matches" | "label"> & { label: string })[]}
 */
const OBSOLETE = [
  { name: "ember-cli-eslint", label: "It lints in the ember-cli build. Run eslint on its own" },
  {
    name: "ember-cli-stylelint",
    label: "It lints in the ember-cli build. Run stylelint on its own",
  },
  { name: "ember-cli-release", label: "It is an ember-cli command" },
  {
    name: "ember-cli-uglify",
    label: "Vite minifies the build",
    buildOptions: ["ember-cli-uglify"],
  },
  { name: "ember-cli-shims", label: "ember-source has the modules that it mapped" },
  {
    name: "ember-cli-htmlbars-inline-precompile",
    label: "babel-plugin-ember-template-compilation compiles `hbs` templates",
  },
  { name: "ember-watson", label: "It is an ember-cli command" },
  {
    name: "ember-cli-qunit",
    label: "ember-qunit replaces it",
    replaceWith: { "ember-qunit": "9.0.4" },
  },
  {
    name: "ember-try",
    label: "It runs ember-cli scenarios",
    files: ["config/ember-try.js"],
    progress: {
      note: "ember-try is removed. To test against other versions, use @embroider/try.",
      links: ["https://github.com/embroider-build/embroider/tree/main/packages/try"],
    },
  },
  { name: "ember-cli-typescript", label: "Babel compiles TypeScript in the Vite build" },
  { name: "ember-cli-typescript-blueprints", label: "It holds ember-cli blueprints" },
  { name: "ember-cli-blueprint-test-helpers", label: "It tests ember-cli blueprints" },
  {
    name: "ember-maybe-import-regenerator",
    label: "Vite builds for browsers with native generators",
  },
  {
    name: "ember-angle-bracket-invocation-polyfill",
    label: "Ember 3.10 and later have angle brackets",
  },
  {
    name: "ember-functions-as-helper-polyfill",
    label: "Ember 4.5 and later call plain functions as helpers",
  },
  {
    name: "ember-cli-code-coverage",
    label: "It instruments the ember-cli build",
    files: [".nycrc", "config/coverage.js"],
    progress: {
      note: "ember-cli-code-coverage is removed, because it instruments the ember-cli build. For coverage of a Vite build, add vite-plugin-istanbul.",
      links: ["https://github.com/iFaxity/vite-plugin-istanbul"],
    },
  },
  {
    name: "ember-cli-moment-shim",
    label: "The app imports moment from npm",
    buildOptions: ["moment"],
    replaceWith: { moment: "2.30.1" },
  },
  {
    name: "ember-mockdate-shim",
    label: "The tests import mockdate from npm",
    replaceWith: { mockdate: "3.0.5" },
  },
  {
    name: "ember-classic-decorator",
    label: "The `@classic` decorator only asserts in development",
    after: (project) => removeDecoratorImports(project, "ember-classic-decorator"),
  },
  {
    name: "ember-percy",
    label: "It takes snapshots through ember-cli",
    after: (project) => removeCalls(project, "ember-percy"),
    progress: {
      note:
        "ember-percy is removed, and so are the percySnapshot calls in the tests. " +
        "@percy/ember has no v2 release yet. To take snapshots again, call @percy/sdk-utils from a test helper.",
      links: [
        "https://github.com/percy/ember-percy",
        "https://www.npmjs.com/package/@percy/sdk-utils",
      ],
    },
  },
  {
    name: "ember-normalize",
    label: "The app imports normalize.css from npm",
    replaceWith: { "normalize.css": "8.0.1" },
    after: importNormalize,
  },
];

/**
 * @param {import('#project.js').Project} project
 * @param {string} module
 * @returns {{ file: string, source: string, locals: string[] }[]} the files that import the module, and the local names of its imports
 */
function importersOf(project, module) {
  let pattern = new RegExp(`^import\\s+(.+?)\\s+from\\s*["']${module}["'];?[ \\t]*\\n`, "m");

  return project
    .files()
    .map((file) => ({ file, source: project.read(file) }))
    .filter(({ source }) => pattern.test(source))
    .map(({ file, source }) => {
      let clause = /** @type {RegExpExecArray} */ (pattern.exec(source))[1];
      let locals = clause
        .replace(/[{}]/g, "")
        .split(",")
        .map(
          (part) =>
            part
              .trim()
              .split(/\s+as\s+/)
              .pop() ?? "",
        )
        .filter(Boolean);

      return { file, source: source.replace(pattern, ""), locals };
    });
}

/**
 * Removes the import of a decorator package, and each use of its decorators, such as `@classic`.
 *
 * @param {import('#project.js').Project} project
 * @param {string} module
 */
function removeDecoratorImports(project, module) {
  for (let { file, source, locals } of importersOf(project, module)) {
    let output = source;

    for (let local of locals) {
      output = output
        .replace(new RegExp(`^[ \\t]*@${local}[ \\t]*\\n`, "gm"), "")
        .replace(new RegExp(`@${local}\\s+(?=(export\\s|class\\s))`, "g"), "");
    }

    project.write(file, output);
  }
}

/**
 * Removes the import of a package, and each statement that only calls one of its imports, such as `await percySnapshot('x');`.
 *
 * @param {import('#project.js').Project} project
 * @param {string} module
 */
function removeCalls(project, module) {
  for (let { file, source, locals } of importersOf(project, module)) {
    let output = source;

    for (let local of locals) {
      output = output.replace(
        new RegExp(`^[ \\t]*(await\\s+)?${local}\\([^;\\n]*\\);?[ \\t]*\\n`, "gm"),
        "",
      );
    }

    /**
     * A call that spans lines stays, with its import, so that the build names it.
     */
    if (locals.some((local) => new RegExp(`\\b${local}\\b`).test(output))) continue;

    project.write(file, output);
  }
}

/**
 * ember-normalize added normalize.css to the styles. The app imports it now, unless its styles do already.
 *
 * @param {import('#project.js').Project} project
 */
function importNormalize(project) {
  let styles = project.files(["app/**/*.{css,scss,sass,less,js,ts}"]);

  if (styles.some((file) => project.read(file).includes("normalize.css"))) return;

  let app = ["app/app.js", "app/app.ts"].find((file) => project.has(file));

  if (!app) return;

  project.write(app, `import "normalize.css";\n${project.read(app)}`);
}

/**
 * One stage for each obsolete addon, so that each removal is its own commit.
 *
 * @type {import('#types.js').StageGroup}
 */
export const obsoleteAddons = {
  name: "obsolete-addons",
  label: "Remove the addons that Vite and Ember 6 replace, one commit for each",

  async expand() {
    return OBSOLETE.map((entry) =>
      removalStage(
        Object.assign({}, entry, {
          label: `Remove ${entry.name}. ${entry.label}`,
          matches: (/** @type {string} */ name) => name === entry.name,
        }),
      ),
    );
  },
};

/**
 * @param {string} name
 * @returns {boolean} a removal stage handles the addon
 */
export function isObsoleteAddon(name) {
  return OBSOLETE.some((entry) => entry.name === name);
}
