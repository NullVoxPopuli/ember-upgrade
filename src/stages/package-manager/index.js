import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  setPnpmMapSetting,
  setYamlNestedMap,
  setYamlScalar,
  workspaceRoot,
} from "#manager-settings.js";
import { editPackageJson, setDependency } from "#package-json.js";
import { exec, published } from "#process.js";
import { APP_DEPENDENCIES, PACKAGE_EXTENSIONS } from "./extensions.js";
import { Project } from "#project.js";
import { recordProgress } from "#progress.js";

/**
 * The settings and the install state of yarn 1 and of yarn 2 and later.
 */
const YARN_FILES = [".yarnrc", ".yarnrc.yml", ".yarn", ".pnp.cjs", ".pnp.loader.mjs"];

/**
 * The fallback when the registry does not answer.
 */
const PNPM_FALLBACK = "12.21.0";

/**
 * Files that often run yarn, and that the stage does not change.
 */
const YARN_USERS = [
  ".github/workflows/*.{yml,yaml}",
  ".circleci/config.yml",
  ".travis.yml",
  "Dockerfile",
  "README.md",
  "CONTRIBUTING.md",
];

/**
 * Moves yarn and npm 6 projects to pnpm.
 *
 * yarn 1 and npm 6 can install a tree with a package that another package does not see, or two copies of one package.
 * pnpm installs exactly what each package.json asks for.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "package-manager",
  label: "Move from yarn or npm 6 to pnpm",

  detect(project) {
    return Boolean(legacyLockfile(project));
  },

  async check(project) {
    let lockfile = legacyLockfile(project);

    return {
      blockers: [],
      todo: lockfile
        ? [
            {
              title: `${lockfile} becomes pnpm-lock.yaml`,
              where: yarnUsers(workspaceRoot(project)),
              action: "Change these files to run pnpm.",
            },
          ]
        : [],
    };
  },

  async run(project) {
    let lockfile = legacyLockfile(project);
    let root = workspaceRoot(project);
    let version = published("pnpm")?.version ?? PNPM_FALLBACK;

    if (!lockfile) return [];

    /**
     * pnpm 10 and later read workspaces, overrides, and settings from pnpm-workspace.yaml.
     * Write it first, so that `pnpm import` reads the workspace packages.
     */
    let pkg = root.packageJson;
    let workspaces = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : /** @type {{ packages?: string[] } | undefined} */ (pkg.workspaces)?.packages;
    let resolutions = /** @type {Record<string, string> | undefined} */ (pkg.resolutions) ?? {};

    if (workspaces && workspaces.length > 0) {
      let packages = workspaces.map((glob) => `  - '${glob}'`).join("\n");
      let existing = root.has("pnpm-workspace.yaml") ? root.read("pnpm-workspace.yaml") : "";

      root.write(
        "pnpm-workspace.yaml",
        `packages:\n${packages}\n` + (existing ? `\n${existing}` : ""),
      );
    }

    if (lockfile === "yarn.lock") {
      let resolved = yarnGitCommits(root.read("yarn.lock"));
      let manifests = [root].concat(
        root
          .files((workspaces ?? []).map((glob) => `${glob}/package.json`))
          .map((file) => new Project(join(root.directory, dirname(file)))),
      );

      for (let manifest of manifests) {
        editPackageJson(manifest, (pkg) => pinGitDependencies(pkg, resolved));
      }
    }

    /**
     * yarn 1 and npm 6 put each hoisted package in the top node_modules, so an
     * `app.import('node_modules/<name>/...')` works for a package that only a dependency lists.
     * pnpm does not, so the app must list it.
     */
    let hoisted = hoistedVersions(root, lockfile);
    let required = importedPackages(project).concat(
      Object.entries(APP_DEPENDENCIES).flatMap(([addon, names]) =>
        project.dependency(addon) ? names : [],
      ),
    );
    let missing = required.filter((name) => !project.dependency(name) && hoisted.has(name));

    editPackageJson(project, (manifest) => {
      for (let name of missing) setDependency(manifest, name, `^${hoisted.get(name)}`);
    });

    editPackageJson(root, (manifest) => {
      manifest.packageManager = `pnpm@${version}`;
      delete manifest.workspaces;
      delete manifest.resolutions;

      for (let [name, script] of Object.entries(manifest.scripts ?? {})) {
        manifest.scripts[name] = String(script)
          .replace(/\byarn run\b/g, "pnpm run")
          .replace(/\bnpm run\b/g, "pnpm run")
          .replace(/\byarn (?=[\w:-]+)/g, "pnpm ");
      }
    });

    for (let [selector, range] of Object.entries(resolutions)) {
      setPnpmMapSetting(project, "overrides", pnpmSelector(selector), range);
    }

    let names = new Set(hoisted.keys());

    for (let [selector, dependencies] of Object.entries(PACKAGE_EXTENSIONS)) {
      if (!names.has(selector.replace(/(.)@.*$/, "$1"))) continue;

      let current = root.has("pnpm-workspace.yaml") ? root.read("pnpm-workspace.yaml") : "";

      root.write(
        "pnpm-workspace.yaml",
        setYamlNestedMap(current, "packageExtensions", selector, "dependencies", dependencies),
      );

      recordProgress(project, {
        id: `packageExtensions ${selector}`,
        status: "workaround",
        note:
          `pnpm-workspace.yaml adds ${Object.keys(dependencies).join(", ")} to ${selector}, because it requires them without listing them. ` +
          "Remove the entry when the addon is updated or removed.",
        links: ["https://pnpm.io/settings#packageextensions"],
      });
    }

    /**
     * yarn 1 and npm 6 ran the build script of each dependency. pnpm 11 and later stop the install
     * when a dependency has a build script that the project did not approve.
     * Approving all of them runs unknown code, so pnpm skips them, and the user approves the ones the app needs.
     */
    let settings = root.has("pnpm-workspace.yaml") ? root.read("pnpm-workspace.yaml") : "";

    /**
     * pnpm 11 and later also refuse a git or tarball dependency of a dependency, which yarn 1 and npm 6 installed.
     */
    root.write(
      "pnpm-workspace.yaml",
      setYamlScalar(setYamlScalar(settings, "strictDepBuilds", false), "blockExoticSubdeps", false),
    );

    /**
     * `pnpm import` reads the old lockfile, so the resolved versions stay the same.
     * npx runs it, because yarn 1 has no `dlx`.
     */
    if (!exec(root, "npx", ["--yes", `pnpm@${version}`, "import"])) {
      throw new Error(`pnpm import failed. Its output is above.`);
    }

    rmSync(join(root.directory, lockfile));
    for (let file of YARN_FILES) {
      rmSync(join(root.directory, file), { force: true, recursive: true });
    }

    let where = yarnUsers(root);

    recordProgress(project, {
      id: "package-manager",
      status: "todo",
      note:
        `${lockfile} became pnpm-lock.yaml, with the same versions. ` +
        "pnpm does not let a package import a dependency that its package.json does not list. " +
        "If a build fails on a missing package, add that package to the package.json that imports it. " +
        "pnpm skips the build scripts of dependencies. Run `pnpm approve-builds` to pick the ones the app needs, " +
        "then remove `strictDepBuilds: false` from pnpm-workspace.yaml. " +
        "`blockExoticSubdeps: false` lets a dependency install another package from git. " +
        "Remove it when no dependency does that." +
        (where.length > 0 ? ` These files still run yarn or npm: ${where.join(", ")}.` : ""),
      links: [
        "https://pnpm.io/motivation",
        "https://pnpm.io/cli/import",
        "https://pnpm.io/cli/approve-builds",
      ],
    });

    return where.length > 0
      ? [{ title: "These files still run yarn or npm", where, action: "Change them to run pnpm." }]
      : [];
  },
};

/**
 * @param {import('#project.js').Project} project
 * @returns {string[]} the packages that the build imports from node_modules
 */
export function importedPackages(project) {
  let names = new Set();
  let pattern = /\b(?:app|this)\.import\(\s*['"`]node_modules\/((?:@[^/'"`]+\/)?[^/'"`]+)/g;

  for (let file of project.files(["ember-cli-build.{js,cjs}", "lib/*/index.{js,cjs}"])) {
    for (let match of project.read(file).matchAll(pattern)) names.add(match[1]);
  }

  return Array.from(names).sort();
}

/**
 * The version of each package in the top node_modules of the old install.
 * yarn 1 does not record which copy it hoisted, so this takes the highest version.
 *
 * @param {import('#project.js').Project} root
 * @param {string} lockfile
 * @returns {Map<string, string>}
 */
export function hoistedVersions(root, lockfile) {
  /** @type {Map<string, string>} */
  let versions = new Map();
  let source = root.read(lockfile);

  if (lockfile === "package-lock.json") {
    for (let [name, entry] of Object.entries(JSON.parse(source).dependencies ?? {})) {
      if (entry.version && /^\d/.test(entry.version)) versions.set(name, entry.version);
    }
    return versions;
  }

  for (let block of source.split(/\n\n+/)) {
    let [header] = block.split("\n");
    /**
     * yarn 1 writes `version "1.0.0"`, and yarn 2 and later write `version: 1.0.0`.
     */
    let version = block.match(/^ {2}version:? "?([^"\n]+?)"?$/m)?.[1];

    if (!version || !header.endsWith(":")) continue;

    let name = header.replace(/^"/, "").match(/^(@?[^@]+)@/)?.[1];
    let current = name ? versions.get(name) : undefined;

    if (name && (!current || compareVersions(version, current) > 0)) versions.set(name, version);
  }

  return versions;
}

/**
 * @param {string} a
 * @param {string} b
 */
function compareVersions(a, b) {
  let left = a.split(/[.-]/).map(Number);
  let right = b.split(/[.-]/).map(Number);

  for (let i = 0; i < 3; i++) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  }

  return 0;
}

/**
 * Reads the commit that yarn 1 resolved for each git dependency.
 *
 * @param {string} lockfile the contents of a yarn 1 yarn.lock
 * @returns {Map<string, string>} from `name@spec` to the resolved URL with its commit
 */
export function yarnGitCommits(lockfile) {
  let commits = new Map();

  for (let block of lockfile.split(/\n\n+/)) {
    let [header] = block.split("\n");
    let url = block.match(/^ {2}resolved "([^"]+)"$/m)?.[1] ?? "";
    let codeload = url.match(
      /^https:\/\/codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\/([0-9a-f]{40})$/,
    );
    let resolved = codeload
      ? `github:${codeload[1]}#${codeload[2]}`
      : /^(git\+|git:|ssh:|https:\/\/github\.com\/)[^#]+#[0-9a-f]{40}$/.test(url)
        ? url
        : undefined;

    if (!resolved || !header.endsWith(":")) continue;

    for (let key of header.slice(0, -1).split(/,\s*/)) {
      commits.set(key.replace(/^"|"$/g, ""), resolved);
    }
  }

  return commits;
}

/**
 * Changes each git dependency to the commit that the lockfile resolved.
 * pnpm cannot resolve some refs that yarn 1 accepted, such as `#master#2023-08-30`.
 *
 * @param {import('#package-json.js').Manifest} pkg
 * @param {Map<string, string>} commits from `yarnGitCommits`
 */
export function pinGitDependencies(pkg, commits) {
  for (let section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (let [name, spec] of Object.entries(pkg[section] ?? {})) {
      let resolved = commits.get(`${name}@${spec}`);

      if (resolved && resolved !== spec) pkg[section][name] = resolved;
    }
  }
}

/**
 * @param {import('#project.js').Project} project
 * @returns {string | undefined} the name of a yarn or npm 6 lockfile
 */
function legacyLockfile(project) {
  let lockfile = project.lockfile;

  if (!lockfile) return;

  let root = workspaceRoot(project);

  /**
   * yarn 2 and later write `__metadata:` at the top. `pnpm import` reads both formats.
   */
  if (
    lockfile.name === "yarn.lock" &&
    /^(# yarn lockfile v1|__metadata:)/m.test(root.read("yarn.lock"))
  ) {
    return "yarn.lock";
  }

  if (lockfile.name === "package-lock.json") {
    let version = root.read("package-lock.json").match(/"lockfileVersion":\s*(\d+)/)?.[1];

    if (version === "1") return "package-lock.json";
  }
}

/**
 * yarn selects a nested package with a path, such as `parent/name`, and any depth with a leading `**`.
 * pnpm selects with `name` and `parent>name`.
 *
 * @param {string} selector
 */
export function pnpmSelector(selector) {
  /**
   * Put each scoped name (`@scope/name`) back together.
   */
  let parts = selector.split("/");
  let names = [];

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith("@") && i + 1 < parts.length) {
      names.push(`${parts[i]}/${parts[i + 1]}`);
      i++;
    } else {
      names.push(parts[i]);
    }
  }

  /**
   * pnpm has no selector for "at any depth", so that becomes an override for every copy.
   */
  if (names.includes("**")) return names[names.length - 1];

  /**
   * A pnpm selector has at most one parent, so a deeper path keeps its last parent.
   */
  return names.slice(-2).join(">");
}

/**
 * @param {import('#project.js').Project} root
 */
function yarnUsers(root) {
  return root
    .files(YARN_USERS)
    .filter((file) => /\byarn\b|\bnpm (ci|install|run)\b/.test(root.read(file)));
}
