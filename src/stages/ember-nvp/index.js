import { renameSync, rmSync } from "node:fs";
import { join, posix } from "node:path";

import { buildFile, removeCompatBuildOptions, viteConfig } from "#config-files.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { updateNodePins } from "#node-version.js";
import { recordProgress } from "#progress.js";
import { atLeast, minorOf } from "#version.js";
import { fixStylesheetImports } from "./css-imports.js";
import { resolveCopies } from "#stages/dependency-copies/index.js";
import { BABEL_CONFIGS } from "#stages/vite/warp-drive-config.js";
import { ESLINT_CONFIGS, withoutBabelConfigFile } from "./eslint-babel.js";
import { install, packageManager, runUpstream } from "#process.js";
import { flatRulesOf, flatSettings, readEslintrc, withFlatSettings } from "./eslintrc.js";

/**
 * The flat config that the eslint-bundled layer writes.
 */
const FLAT_CONFIG = "eslint.config.js";

/**
 * ember.nvp makes the package a module, and Node then loads each `.js` file as one.
 * A CommonJS config, such as `.prettierrc.js`, becomes `.cjs`, so that its tool can load it.
 *
 * @param {import('#project.js').Project} project
 * @returns {string[]} the renamed files
 */
export function renameCommonJs(project) {
  if (project.packageJson.type !== "module") return [];

  let renamed = project
    .files(["*.js", ".*.js", "config/*.js"])
    .filter((file) => file !== FLAT_CONFIG)
    .filter((file) => {
      let source = project.read(file);

      return (
        /\bmodule\.exports\b|\brequire\(/.test(source) && !/^\s*(import|export)\s/m.test(source)
      );
    });

  for (let file of renamed) {
    renameSync(
      join(project.directory, file),
      join(project.directory, file.replace(/\.js$/, ".cjs")),
    );
  }

  return renamed;
}

/**
 * The files that can require or import a module in config/.
 */
const MODULE_USERS = [
  "*.{js,cjs,mjs,ts}",
  ".*.{js,cjs}",
  "config/**/*.{js,cjs,mjs,ts}",
  "lib/**/*.{js,cjs,mjs,ts}",
  "app/**/*.{js,ts,gjs,gts}",
  "tests/**/*.{js,ts,gjs,gts}",
];

const SPECIFIER = /(?:require\(\s*|import\(\s*|from\s+|import\s+)["'](\.{1,2}\/[^"']+)["']/g;

/**
 * @param {string} file
 * @returns {string}
 */
function withoutExtension(file) {
  return file.replace(/\.[cm]?[jt]s$/, "");
}

/**
 * The Vite config of the vite stage built with this plugin, and the one of ember.nvp does not.
 * Its newest release still asks for Babel 7, which npm refuses next to the Babel 8 of ember.nvp.
 */
const CLASSIC_VITE_PACKAGES = ["@rollup/plugin-babel"];

/**
 * @param {import('#project.js').Project} project
 * @returns {string[]} the packages of the classic Vite config that no config imports anymore
 */
export function removeClassicVitePackages(project) {
  let configs = [viteConfig(project)]
    .concat(BABEL_CONFIGS)
    .filter((file) => file && project.has(file))
    .map((file) => project.read(/** @type {string} */ (file)));
  let unused = CLASSIC_VITE_PACKAGES.filter(
    (name) => project.dependency(name) && !configs.some((source) => source.includes(name)),
  );

  if (unused.length > 0) {
    editPackageJson(project, (pkg) => {
      for (let name of unused) removeDependency(pkg, name);
    });
  }

  return unused;
}

/**
 * The first release, in the same major, whose Babel plugin accepts the Babel 8 of ember.nvp.
 * ember-concurrency 5.2 and older assert Babel 7 in async-arrow-task-transform.
 *
 * @type {Map<string, [number, number]>}
 */
const BABEL_8_RELEASES = new Map([["ember-concurrency", [5, 3]]]);

/**
 * @param {import('#project.js').Project} project
 * @returns {string[]} the packages that moved to a release that accepts Babel 8
 */
export function raiseForBabel8(project) {
  /** @type {string[]} */
  let raised = [];

  editPackageJson(project, (pkg) => {
    for (let [name, [major, minor]] of BABEL_8_RELEASES) {
      let range = project.dependency(name);

      if (minorOf(range)?.[0] !== major || atLeast(range, major, minor)) continue;

      setDependency(pkg, name, `^${major}.${minor}.0`);
      raised.push(name);
    }
  });

  return raised;
}

/**
 * @param {import('#project.js').Project} project
 * @returns {Map<string, Set<string>>} each module in config/, with the files that require or import it
 */
export function configModuleUsers(project) {
  /** @type {Map<string, Set<string>>} */
  let users = new Map();
  /** @type {Map<string, string>} */
  let modules = new Map();

  for (let module of project.files(["config/**/*.{js,cjs,mjs}"])) {
    users.set(module, new Set());
    modules.set(withoutExtension(module), module);
  }

  for (let file of project.files(MODULE_USERS)) {
    for (let [, specifier] of project.read(file).matchAll(SPECIFIER)) {
      let target = posix.normalize(posix.join(posix.dirname(file), specifier));
      let module = modules.get(withoutExtension(target));

      if (module && module !== file) users.get(module)?.add(file);
    }
  }

  return users;
}

/**
 * ember.nvp replaces files such as ember-cli-build.js and config/environment.js.
 * A helper module in config/ that only those files required has no use after it.
 *
 * @param {import('#project.js').Project} project
 * @param {Map<string, Set<string>>} before from `configModuleUsers`, before ember.nvp ran
 * @returns {string[]} the removed modules
 */
export function removeOrphanConfigModules(project, before) {
  let after = configModuleUsers(project);
  /** @type {string[]} */
  let removed = [];

  for (let [module, users] of before) {
    if (users.size === 0 || !project.has(module) || (after.get(module)?.size ?? 0) > 0) continue;
    if (Array.from(users).some((user) => project.has(user))) continue;

    rmSync(join(project.directory, module));
    removed.push(module);
  }

  return removed;
}

/** @type {import('#types.js').Stage} */
export default {
  name: "ember-nvp",
  label: "Move to the ember.nvp layout (ember.nvp migration)",

  detect(project) {
    /**
     * ember.nvp apps build without @embroider/compat, so they have no ember-cli-build.
     */
    return Boolean(project.dependency("@embroider/vite")) && Boolean(buildFile(project));
  },

  async check(project) {
    /** @type {import('#types.js').Report} */
    let report = { blockers: [], todo: [] };
    let hbs = project.files(["app/**/*.hbs"]);

    if (hbs.length > 0) {
      report.blockers.push({
        title: "Templates in .hbs files",
        where: hbs,
        action: "Run the template-tag stage first. ember.nvp apps build without @embroider/compat.",
      });
    }

    return report;
  },

  async run(project) {
    /**
     * ember.nvp apps read no config modules or app boot code of addons, and ember.nvp stops on these options.
     * The compat build of the stages before this one needs it, when a v1 addon has a config module.
     */
    removeCompatBuildOptions(project, ["useAddonConfigModule", "useAddonAppBoot"]);

    updateNodePins(project);

    /**
     * Without a name, ember.nvp gives the app the name of its template, and imports of `<name>/...` stop resolving.
     */
    let args = [
      "--name",
      String(project.packageJson.name),
      "--path",
      project.directory,
      "--replaceOrUpdate",
      "update",
      "--type",
      "app",
      "--confirm",
      "yes",
    ];

    /**
     * Without it, ember.nvp writes pnpm scripts, also in an npm project.
     */
    let pm = packageManager(project);

    if (pm === "npm" || pm === "pnpm") args.push("--packageManager", pm);

    /**
     * The ember-source stages update ESLint to a version that does not read a legacy config.
     * ember.nvp replaces it with a flat config, and removes it, so the stage reads it first.
     */
    let eslintrc = readEslintrc(project);
    let configUsers = configModuleUsers(project);

    if (!runUpstream(project, "ember.nvp@3.1.2", args)) {
      throw new Error("ember.nvp failed. Its output is above.");
    }

    /**
     * The compat build wrote its addon list to node_modules/.embroider/resolver.json.
     * Embroider reads that file when it exists, so a dependency that a later change removes would stay in the build.
     */
    rmSync(join(project.directory, "node_modules", ".embroider"), { recursive: true, force: true });

    removeOrphanConfigModules(project, configUsers);
    renameCommonJs(project);
    removeClassicVitePackages(project);
    raiseForBabel8(project);

    /**
     * The migration changes dependency ranges, so the imports are checked against what its install gives.
     */
    if (!install(project)) throw new Error("The install after ember.nvp failed.");

    /**
     * The migration moves the app to the Babel major of the base, and the lockfile keeps the old Babel for the build packages.
     */
    resolveCopies(project);

    let stylesheets = fixStylesheetImports(project);

    if (stylesheets.length > 0) {
      recordProgress(project, {
        id: "stylesheet imports",
        status: "check",
        note:
          `These imports named stylesheets that their packages do not have, and the Vite build of ember.nvp resolves each import. ` +
          `They name each package's one stylesheet now: ${stylesheets.join(", ")}.`,
      });
    }

    for (let file of ESLINT_CONFIGS) {
      if (!project.has(file)) continue;

      let config = project.read(file);
      let output = withoutBabelConfigFile(config, file);

      if (output !== config) project.write(file, output);
    }

    if (!eslintrc || !project.has(FLAT_CONFIG) || readEslintrc(project)) return [];

    let source = withFlatSettings(
      project.read(FLAT_CONFIG),
      flatSettings(eslintrc, await flatRulesOf(project, FLAT_CONFIG)),
    );

    if (source) project.write(FLAT_CONFIG, source);

    return [];
  },
};
