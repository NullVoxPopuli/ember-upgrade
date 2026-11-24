import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildFile } from "#config-files.js";
import { dependencyNames, editPackageJson, removeDependency } from "#package-json.js";
import { install } from "#process.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

/**
 * The text files where an app names a package: code, configs, styles and HTML.
 */
const TEXT_FILES = [
  "**/*.{js,mjs,cjs,ts,mts,cts,gjs,gts,hbs,json,yml,yaml,scss,sass,css,less,html}",
  "**/.*.{js,mjs,cjs,json,yml,yaml}",
  "**/.*rc",
];

/**
 * Files that list packages without using them.
 */
const NOT_USES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "ember-upgrade-progress.yaml",
  "eslint-suppressions.json",
]);

/**
 * Packages that tools load without an import, such as the compiler of a TypeScript app.
 */
const IMPLICIT = [/^@types\//, /^@glint\//, /^typescript$/, /^ember-source$/, /^@babel\/runtime$/];

/**
 * A tool's config file is a use of the tool, also when no script runs it, as for an editor's formatter.
 *
 * @type {Record<string, RegExp>}
 */
const CONFIG_OF = {
  prettier: /^(\.prettierrc(\.\w+)?|prettier\.config\.\w+)$/,
  eslint: /^(\.eslintrc(\.\w+)?|eslint\.config\.\w+)$/,
  "ember-template-lint": /^\.template-lintrc(\.\w+)?$/,
  testem: /^testem\.\w+$/,
  stylelint: /^(\.stylelintrc(\.\w+)?|stylelint\.config\.\w+)$/,
};

/**
 * Files that only a package reads.
 *
 * @type {Record<string, string[]>}
 */
const FILES_OF = {
  "ember-cli-deprecation-workflow": ["config/deprecation-workflow.js"],
};

/**
 * A quoted string that starts with a package name: an import, a require, a plugin name in a config, or a Sass import.
 */
const SPECIFIER = /["'`](@[\w.-]+\/[\w.-]+|\w[\w.-]*)(?=["'`/])/g;

/**
 * @param {Project} project
 * @param {string} name
 * @returns {Record<string, any> | undefined}
 */
function manifestOf(project, name) {
  let file = join(project.directory, "node_modules", name, "package.json");

  if (!existsSync(file)) return;

  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return;
  }
}

/**
 * @param {Record<string, any>} manifest
 * @param {string} name
 * @returns {string[]}
 */
function binsOf(manifest, name) {
  if (typeof manifest.bin === "string") return [name.split("/").pop() ?? name];

  return Object.keys(manifest.bin ?? {});
}

/**
 * The dependencies that nothing uses: no file names them, no script runs their command,
 * and no dependency that is in use has them as a peer.
 *
 * @param {Project} project
 * @returns {string[]}
 */
export function unusedDependencies(project) {
  let declared = dependencyNames(project.packageJson);
  /** @type {Set<string>} */
  let named = new Set();

  for (let file of project.files(TEXT_FILES)) {
    if (NOT_USES.has(file) || file.split("/").includes(".git")) continue;

    for (let [tool, pattern] of Object.entries(CONFIG_OF)) {
      if (pattern.test(file)) named.add(tool);
    }

    for (let match of project.read(file).matchAll(SPECIFIER)) named.add(match[1]);
  }

  let scripts = Object.values(project.packageJson.scripts ?? {}).join(" ");
  let words = new Set(scripts.split(/[\s;&|()"'=]+/));
  /** @type {Set<string>} */
  let used = new Set();
  /** @type {string[]} */
  let queue = [];

  let use = (/** @type {string} */ name) => {
    if (used.has(name) || !declared.includes(name)) return;

    used.add(name);
    queue.push(name);
  };

  /**
   * An app with an ember-cli build loads each addon in package.json, with or without an import.
   */
  let classic = Boolean(buildFile(project));

  for (let name of declared) {
    let manifest = manifestOf(project, name);
    let ran = manifest ? binsOf(manifest, name).some((bin) => words.has(bin)) : false;
    let loaded = classic && Boolean(manifest?.keywords?.includes("ember-addon"));

    if (
      named.has(name) ||
      ran ||
      loaded ||
      words.has(name) ||
      IMPLICIT.some((pattern) => pattern.test(name))
    ) {
      use(name);
    }
  }

  /**
   * A package in use needs its peers, also the optional ones that the app installed, such as `sass` for Vite.
   */
  for (let name = queue.shift(); name; name = queue.shift()) {
    let manifest = manifestOf(project, name);

    for (let peer of Object.keys(manifest?.peerDependencies ?? {})) use(peer);
  }

  /**
   * Without node_modules, a package's commands and peers are not known, so nothing is unused.
   */
  if (!existsSync(join(project.directory, "node_modules"))) return [];

  return declared.filter((name) => !used.has(name));
}

/**
 * Removes the unused dependencies, and the files that only they read.
 * Peers count only for packages in use, so one pass finds the peers that only unused packages had.
 *
 * @param {Project} project
 * @returns {string[]} the removed packages
 */
export function removeUnused(project) {
  let names = unusedDependencies(project);

  editPackageJson(project, (pkg) => {
    for (let name of names) removeDependency(pkg, name);
  });

  for (let name of names) {
    for (let file of FILES_OF[name] ?? []) {
      rmSync(join(project.directory, file), { force: true });
    }
  }

  return names;
}

/**
 * The upgrade replaces many tools and addons, and the packages that only they used stay in package.json.
 * The project's maintainers would have to find them by hand.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "unused-dependencies",
  label: "Remove the dependencies that no file, script or other dependency uses",
  needsInstall: true,

  detect(project) {
    return unusedDependencies(project).length > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let removed = removeUnused(project);

    install(project);

    recordProgress(project, {
      id: "unused-dependencies",
      status: "removed",
      note:
        `No file, script or other dependency used these packages: ${removed.join(", ")}. ` +
        "If a tool loads one of them by itself, add it back.",
    });

    return [];
  },
};
