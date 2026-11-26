import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProgram } from "#ast.js";
import { addVitePlugin, removeBuildOptions, viteConfig } from "#config-files.js";
import { Edits } from "#edits.js";
import { installedAddonTree, resolvePackage } from "#installed.js";
import {
  addOverride,
  allowBuild,
  overrideRange,
  pnpmMajor,
  removeOverride,
} from "#manager-settings.js";
import {
  dependencyNames,
  editPackageJson,
  removeDependency,
  setDependency,
} from "#package-json.js";
import { install, packageManager, published, runUpstream } from "#process.js";
import { readProgress, recordProgress } from "#progress.js";
import { dropPatches } from "#stages/patched-packages/index.js";
import { atLeast, minorOf } from "#version.js";
import { rewriteClickOutside } from "./click-outside.js";
import { addBasicDropdownWormhole, updateOptionClicks, updatePowerSelect } from "./power-select.js";
import { dependencyDirectory, inlineV1Stage } from "./inline-v1.js";
import { mergedStyleImports, moveMergedStyleImports } from "./merged-styles.js";
import { isObsoleteAddon } from "./removals.js";
import { truthHelperPaths } from "./truth-helpers.js";
import { IGNORED, NO_V2_YET, installedV1Addons, isV1Addon as isV1Manifest } from "./known.js";
import { ICONS_MODULE, iconsModule, rewriteDynamicIcons } from "./svg-jar-icons.js";

/** @typedef {import('#types.js').Stage} Stage */
/** @typedef {import('#types.js').Finding} Finding */

const APP_FILES = ["app/app.js", "app/app.ts"];
const WORKFLOW = "app/deprecation-workflow.js";
const OLD_WORKFLOW = "config/deprecation-workflow.js";

const STYLEGUIDE_CSS = "import 'ember-styleguide/styles.css';";

/**
 * ember-styleguide 11 added its CSS to the ember-cli build. The v2 addon exports it, and the app imports it,
 * before the app's own stylesheets, which can override it.
 *
 * @param {import('#project.js').Project} project
 */
function importStyleguideCss(project) {
  let file = APP_FILES.find((name) => project.has(name));

  if (!file) return;

  let source = project.read(file);

  if (source.includes("ember-styleguide/styles.css")) return;

  let program = parseProgram(source, file);
  let imports = (program?.body ?? []).filter(
    (/** @type {import('#ast.js').Node} */ node) => node.type === "ImportDeclaration",
  );
  let stylesheet = imports.find((/** @type {import('#ast.js').Node} */ node) =>
    /\.(css|scss|sass|less)$/.test(String(node.source.value)),
  );
  let last = imports[imports.length - 1];
  let edits = new Edits(source);

  if (stylesheet) edits.insert(stylesheet.start, `${STYLEGUIDE_CSS}\n`);
  else if (last) edits.insert(last.end, `\n${STYLEGUIDE_CSS}`);
  else edits.insert(0, `${STYLEGUIDE_CSS}\n`);

  project.write(file, edits.apply());
}

/**
 * @param {import('#project.js').Project} project
 * @returns {boolean} the app has the v2 ember-styleguide, and app/app.js does not import its CSS
 */
function needsStyleguideCss(project) {
  let range = project.dependency("ember-styleguide");
  let file = APP_FILES.find((name) => project.has(name));

  return Boolean(
    range &&
    (range === STYLEGUIDE_REF || atLeast(range, 12, 0)) &&
    file &&
    !project.read(file).includes("ember-styleguide/styles.css"),
  );
}

/**
 * The classic build compiles imported CSS with webpack's css-loader, which cannot resolve the fonts and
 * public images that the styleguide's CSS names, so the import waits for Vite, which leaves those URLs to the browser.
 *
 * @type {Stage}
 */
export const emberStyleguideCss = {
  name: "ember-styleguide-css",
  label: "Import the CSS of the v2 ember-styleguide in app/app.js",

  detect(project) {
    return Boolean(project.dependency("@embroider/vite")) && needsStyleguideCss(project);
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    importStyleguideCss(project);
    return [];
  },
};

/**
 * Adds `import './deprecation-workflow';` as the first import of app/app.js,
 * so that the workflow handles the deprecations of the modules that come after it.
 *
 * @param {import('#project.js').Project} project
 */
function importWorkflow(project) {
  let file = APP_FILES.find((name) => project.has(name));

  if (!file) return;

  let source = project.read(file);

  if (source.includes("deprecation-workflow")) return;

  let program = parseProgram(source, file);
  let first = program?.body.find((/** @type {any} */ node) => node.type === "ImportDeclaration");
  let edits = new Edits(source);

  edits.insert(first ? first.start : 0, "import './deprecation-workflow';\n");
  project.write(file, edits.apply());
}

/** @type {Stage} */
export const deprecationWorkflow = {
  name: "ember-cli-deprecation-workflow",
  label: "Update ember-cli-deprecation-workflow to v4, the v2 addon",

  detect(project) {
    let range = project.dependency("ember-cli-deprecation-workflow");

    return Boolean(range) && !atLeast(range, 4, 0);
  },

  async check(project) {
    /** @type {import('#types.js').Report} */
    let report = { blockers: [], todo: [] };

    if (project.has(OLD_WORKFLOW) && !project.has(WORKFLOW)) {
      report.todo.push({
        title: `Move ${OLD_WORKFLOW} to ${WORKFLOW}`,
        where: [OLD_WORKFLOW],
        action:
          "v4 reads its setup from the app. Call setupDeprecationWorkflow() with the same config in " +
          `${WORKFLOW}. See https://github.com/ember-cli/ember-cli-deprecation-workflow#getting-started.`,
      });
    }

    return report;
  },

  async run(project) {
    editPackageJson(project, (pkg) =>
      setDependency(pkg, "ember-cli-deprecation-workflow", "^4.0.1"),
    );

    if (project.has(WORKFLOW)) importWorkflow(project);

    return (await this.check(project)).todo;
  },
};

const STYLEGUIDE_PR = "https://github.com/ember-learn/ember-styleguide/pull/551";
const STYLEGUIDE_SHA = "a00373bc5bf1a9f125545c6ed470294cf86bc907";
const STYLEGUIDE_REF = `github:NullVoxPopuli-ai-agent/ember-styleguide#${STYLEGUIDE_SHA}`;
const STYLEGUIDE_TARBALL = `https://codeload.github.com/NullVoxPopuli-ai-agent/ember-styleguide/tar.gz/${STYLEGUIDE_SHA}`;

/** @type {Stage} */
export const emberStyleguide = {
  name: "ember-styleguide",
  label: "Install ember-styleguide as a v2 addon, from the branch of its open v2 pull request",

  detect(project) {
    let range = project.dependency("ember-styleguide");

    return Boolean(range) && !range?.includes(":") && !atLeast(range, 12, 0);
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let release = published("ember-styleguide");

    if (release?.v2) {
      editPackageJson(project, (pkg) =>
        setDependency(pkg, "ember-styleguide", `^${release.version}`),
      );
      if (project.dependency("@embroider/vite")) importStyleguideCss(project);
      return [];
    }

    editPackageJson(project, (pkg) => setDependency(pkg, "ember-styleguide", STYLEGUIDE_REF));

    if (project.dependency("@embroider/vite")) importStyleguideCss(project);

    if (packageManager(project) === "pnpm") {
      allowBuild(project, "ember-styleguide");

      /**
       * pnpm 11 allows the build of a git-hosted package by the URL of its tarball.
       */
      if (pnpmMajor(project) >= 11) allowBuild(project, `ember-styleguide@${STYLEGUIDE_TARBALL}`);
    }

    recordProgress(project, {
      id: "ember-styleguide",
      status: "git-ref",
      note:
        "ember-styleguide installs from the branch of its v2 pull request, because no v2 version is released. " +
        "Change it to the released version when the pull request is merged.",
      links: [STYLEGUIDE_PR],
    });

    return [];
  },
};

/**
 * @svg-jar/codemod 0.0.1 with svg-jar/codemod PRs 2 and 3, and a built dist/.
 * Go back to the npm version when a release has them.
 */
const SVG_JAR_CODEMOD =
  "github:NullVoxPopuli-ai-agent/codemod#6809cae188e3178e2c045bbbf5173b5a0a48ca2c";

/**
 * @param {import('#project.js').Project} project
 * @returns {string[]} the files that still use ember-svg-jar
 */
function svgJarUsers(project) {
  return project
    .files(["{app,tests}/**/*.{js,ts,gjs,gts,hbs}"])
    .filter(
      (file) => file !== ICONS_MODULE && /ember-svg-jar|\{\{svg-?[jJ]ar\b/.test(project.read(file)),
    );
}

/**
 * Runs after the template-tag stage, because the svg-jar codemod changes .gjs and .gts files.
 * ember-svg-jar does not work with Vite, so the stage always removes it.
 * The codemod needs a string for each icon name. A call with a name that is only known at runtime
 * looks the icon up in a generated map of every icon in the svgJar source dirs.
 *
 * @type {Stage}
 */
export const svgJar = {
  name: "svg-jar",
  label: "Replace ember-svg-jar with @svg-jar/plugin (@svg-jar/codemod)",

  detect(project) {
    return Boolean(project.dependency("ember-svg-jar"));
  },

  async check(project) {
    /** @type {import('#types.js').Report} */
    let report = { blockers: [], todo: [] };
    let hbs = project.files(["app/**/*.hbs"]);

    if (!viteConfig(project)) {
      report.blockers.push({
        title: "No vite.config file",
        action: "Run the vite stage first.",
      });
    }

    if (hbs.length > 0) {
      report.blockers.push({
        title: "Templates in .hbs files",
        where: hbs,
        action:
          "Run the template-tag stage first. The svg-jar codemod changes .gjs and .gts files only.",
      });
    }

    return report;
  },

  async run(project) {
    let dynamic = [];

    for (let file of project.files(["{app,tests}/**/*.{gjs,gts}"])) {
      let output = rewriteDynamicIcons(project.read(file), file);

      if (output === undefined) continue;

      project.write(file, output);
      dynamic.push(file);
    }

    if (dynamic.length > 0) {
      project.write(ICONS_MODULE, iconsModule(project));
      recordProgress(project, {
        id: "svg-jar: icon map",
        status: "added",
        note:
          `${ICONS_MODULE} imports every icon, because ${dynamic.join(", ")} pick the icon by name at runtime. ` +
          "Pass the icon component to those templates instead of its name, then delete the map.",
      });
    }

    /**
     * The codemod reads `svgJar.sourceDirs` from ember-cli-build, so the option stays until it is done.
     */
    if (!runUpstream(project, SVG_JAR_CODEMOD, [project.directory])) {
      throw new Error("@svg-jar/codemod failed. Its output is above.");
    }

    editPackageJson(project, (pkg) => setDependency(pkg, "@svg-jar/plugin", "^1.1.0"));

    let added = addVitePlugin(project, {
      specifier: "@svg-jar/plugin/vite",
      importLine: "import svgJar from '@svg-jar/plugin/vite';",
      call: "svgJar({ target: 'ember' })",
    });

    /** @type {Finding[]} */
    let todo = [];

    if (!added) {
      todo.push({
        title: "Add the svg-jar plugin to the Vite config",
        where: [viteConfig(project) ?? "vite.config.mjs"],
        action: "Add `svgJar({ target: 'ember' })` from '@svg-jar/plugin/vite' to `plugins`.",
      });
    }

    let users = svgJarUsers(project);

    if (users.length > 0) {
      throw new Error(
        `The svg-jar codemod did not find the icons in ${users.join(", ")}. Its output is above.`,
      );
    }

    editPackageJson(project, (pkg) => removeDependency(pkg, "ember-svg-jar"));
    removeBuildOptions(project, ["svgJar"]);

    return todo;
  },
};

/**
 * The addons that a stage of their own updates, replaces, or removes.
 *
 * @param {string} name
 */
function hasOwnStage(name) {
  return (
    isObsoleteAddon(name) ||
    name === "ember-cli-deploy" ||
    name.startsWith("ember-cli-deploy-") ||
    [
      "@mainmatter/ember-api-actions",
      "@zestia/ember-auto-focus",
      "ember-cli-autoprefixer",
      "ember-cli-bundle-analyzer",
      "ember-cli-dependency-lint",
      "ember-cli-head",
      "ember-cli-sass",
      "ember-disable-prototype-extensions",
      "ember-error-route",
      "ember-event-helpers",
      "ember-test-selectors",
      "qunit-console-grouper",
      "prember",
      "ember-cli-deprecation-workflow",
      "ember-metrics",
      "ember-styleguide",
      "ember-svg-jar",
      "ember-web-app",
      "ember-power-select-typeahead",
      "ember-router-scroll",
      "ember-scoped-css-compat",
      "ember-cli-netlify",
      "@percy/ember",
      "ember-leaflet",
    ].includes(name)
  );
}

/**
 * @param {import('#project.js').Project} project
 * @param {string} dependency
 * @param {string} range
 * @returns {boolean} the range gives a v2 addon, and an installed v1 addon depends on the package
 * without ember-auto-import 2, which v1 addons need to load a v2 addon
 */
function oldAddonsNeed(project, dependency, range) {
  let release = published(dependency, range);

  if (!release?.addon || !release.v2) return false;

  return installedAddonTree(project).some(
    ({ manifest }) =>
      isV1Manifest(manifest) &&
      manifest.dependencies?.[dependency] &&
      !atLeast(manifest.dependencies?.["ember-auto-import"], 2, 0),
  );
}

/**
 * A newer pin stays, such as the ones that the vite stage adds.
 *
 * @param {string} pin
 * @param {string} range
 * @returns {boolean} the pin forces an older major than the range, or an older minor of a 0.x release
 */
function olderRelease(pin, range) {
  let [pinMajor, pinMinor] = minorOf(pin) ?? [];
  let [major, minor] = minorOf(range) ?? [];

  if (pinMajor === undefined || pinMinor === undefined || major === undefined) return false;
  if (minor === undefined || atLeast(pin, major, minor)) return false;

  return pinMajor !== major || (major === 0 && pinMinor !== minor);
}

/**
 * @param {string} name
 * @param {import('#process.js').Published} release
 * @returns {Stage}
 */
export function updateStage(name, release) {
  let major = minorOf(release.version)?.[0] ?? 0;
  let format = release.addon ? "a v2 addon" : "a plain npm package";

  return {
    name: `update-${name}`,
    label: `Update ${name} to ${release.version}, which is ${format}`,

    detect(project) {
      return !atLeast(project.dependency(name), major, 0);
    },

    async check() {
      return { blockers: [], todo: [] };
    },

    async run(project) {
      /**
       * An override of the addon itself, or of what it needs, can hold back the update.
       * The override goes to the range that the release asks for, because it kept the dependency tree on one copy,
       * and two copies of some v1 addons, such as @ember/test-waiters 3, break the build.
       * It goes away when it would force a v2 addon on a v1 addon that cannot load one.
       */
      let wanted = Object.assign({}, release.dependencies, release.peerDependencies, {
        [name]: `^${release.version}`,
      });
      /** @type {string[]} */
      let unpinned = [];

      for (let [dependency, range] of Object.entries(wanted)) {
        let pin = overrideRange(project, dependency);

        if (pin && olderRelease(pin, range)) {
          if (oldAddonsNeed(project, dependency, range)) removeOverride(project, dependency);
          else addOverride(project, dependency, range);

          unpinned.push(`${dependency} (${pin}, and ${name} ${release.version} asks for ${range})`);
        }
      }

      let styleImports = mergedStyleImports(project, name);

      dropPatches(project, [name]);

      editPackageJson(project, (pkg) => {
        setDependency(pkg, name, `^${release.version}`);

        for (let [peer, range] of Object.entries(release.peerDependencies ?? {})) {
          if (peer === "ember-source" || pkg.dependencies?.[peer] || pkg.devDependencies?.[peer]) {
            continue;
          }

          setDependency(pkg, peer, range);
        }
      });

      /** @type {Finding[]} */
      let todo = [];
      let codemod = TEMPLATE_CODEMODS.get(name);

      /**
       * The new files are in the v2 addon, so it must be installed first.
       */
      if (styleImports.size > 0) {
        if (!install(project)) throw new Error(`The install of ${name} ${release.version} failed.`);

        let missing = moveMergedStyleImports(project, name, styleImports);

        if (missing.length > 0) {
          todo.push({
            title: `Sass imports of the styles that ${name} merged into the app: ${missing.join(", ")}`,
            where: ["app/styles"],
            action: `Import the styles from where ${name} ${release.version} has them. Check its upgrade guide.`,
          });
        }
      }

      if (name === "ember-power-select" || name === "ember-basic-dropdown") {
        addBasicDropdownWormhole(project);
      }

      if (name === "ember-power-select") updateOptionClicks(project);

      for (let file of codemod ? project.files([codemod.files]) : []) {
        let result = /** @type {{ codemod: TemplateCodemod }} */ (codemod).codemod(
          project.read(file),
          file,
        );

        if (result.unreadable.length > 0) {
          todo.push({
            title: `Usage of ${name} that the update cannot change: ${result.unreadable.join("; ")}`,
            where: [file],
          });
        } else if (result.template !== project.read(file)) {
          project.write(file, result.template);
        }
      }

      if (unpinned.length > 0) {
        recordProgress(project, {
          id: `${name}: overrides`,
          status: "override",
          note:
            `package.json forced versions that ${name} ${release.version} does not accept, so the overrides force the ranges that it asks for: ` +
            `${unpinned.join(", ")}. Remove each override when the dependency tree has one copy without it.`,
        });
      }

      return todo.concat([
        {
          title: `Read the breaking changes of ${name} ${release.version}`,
          where: release.repository ? [release.repository] : [],
          action:
            "The update changes the version only. Change the code that uses the addon, if the release notes say so.",
        },
      ]);
    },
  };
}

/**
 * @param {{ name: string, note: string, links: string[] }[]} addons
 * @returns {Stage}
 */
function v1Record(addons) {
  /**
   * @param {import('#project.js').Project} project
   */
  let missing = (project) => {
    let ids = new Set(readProgress(project).map((entry) => entry.id));

    return addons.filter((addon) => !ids.has(addon.name));
  };

  return {
    name: "v1-addons",
    label: "List the v1 addons that have no v2 release in ember-upgrade-progress.yaml",

    detect(project) {
      return missing(project).length > 0;
    },

    async check() {
      return { blockers: [], todo: [] };
    },

    async run(project) {
      for (let addon of missing(project)) {
        recordProgress(project, {
          id: addon.name,
          status: "v1-addon",
          note: addon.note,
          links: addon.links,
        });
      }

      return [];
    },
  };
}

/**
 * @param {string} directory an installed package
 * @returns {boolean}
 */
function isV1Addon(directory) {
  let manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));

  return (
    Boolean(manifest.keywords?.includes("ember-addon")) && manifest["ember-addon"]?.version !== 2
  );
}

/**
 * @typedef {(source: string, file: string) => { template: string, unreadable: string[] }} TemplateCodemod
 */

/**
 * Template changes for the breaking changes of an addon's update.
 *
 * @type {Map<string, { codemod: TemplateCodemod, files: string }>}
 */
const TEMPLATE_CODEMODS = new Map([
  ["ember-click-outside", { codemod: rewriteClickOutside, files: "{app,addon,tests}/**/*.hbs" }],
  [
    "ember-power-select",
    { codemod: updatePowerSelect, files: "{app,addon,tests}/**/*.{hbs,gjs,gts,js,ts}" },
  ],
  [
    "ember-truth-helpers",
    { codemod: truthHelperPaths, files: "{app,addon,tests}/**/*.{gjs,gts,js,ts}" },
  ],
]);

/**
 * The highest major version that the update of an addon goes to, when a later stage does the next major.
 * ember-concurrency 5 runs only the tasks of native classes, so the ember-concurrency stage updates to it after classic-components.
 */
const MAJOR_CAPS = new Map([["ember-concurrency", "4"]]);

/**
 * @param {string} range such as `^1.0.0 || ^2.0.0`
 * @param {number} major
 * @returns {boolean} a part of the range starts at the major
 */
function allowsMajor(range, major) {
  return range.split("||").some((part) => minorOf(part)?.[0] === major);
}

/**
 * @param {string} directory
 * @returns {Record<string, any>}
 */
function manifestAt(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

/**
 * A v2 addon of the app can have its own copy of another addon of the app, at an older major,
 * such as ember-animated-tools 1 with ember-animated 1, next to the app's ember-animated 2.
 * The old copy can call what the app's versions no longer have, and Embroider stops the build on it.
 * The addon updates when its latest release accepts the app's copy.
 *
 * @param {import('#project.js').Project} project
 * @returns {Stage[]}
 */
function copyUpdates(project) {
  /** @type {Stage[]} */
  let stages = [];

  for (let name of dependencyNames(project.packageJson)) {
    let directory = resolvePackage(project.directory, name);

    if (!directory || hasOwnStage(name) || IGNORED.has(name)) continue;

    let manifest = manifestAt(directory);

    if (manifest["ember-addon"]?.version !== 2) continue;

    let copies = Object.keys(manifest.dependencies ?? {}).filter((dependency) => {
      let own = project.dependency(dependency) && resolvePackage(directory, dependency);

      return own && own !== resolvePackage(project.directory, dependency);
    });

    if (copies.length === 0) continue;

    let release = published(name);
    let current = minorOf(manifest.version)?.[0];
    let latest = minorOf(release?.version)?.[0];

    if (!release || current === undefined || latest === undefined || latest <= current) continue;

    let accepts = copies.every((dependency) => {
      let app = resolvePackage(project.directory, dependency);
      let major = app ? minorOf(manifestAt(app).version)?.[0] : undefined;
      let range = release.dependencies?.[dependency] ?? release.peerDependencies?.[dependency];

      return major !== undefined && typeof range === "string" && allowsMajor(range, major);
    });

    if (accepts) stages.push(updateStage(name, release));
  }

  return stages;
}

/**
 * One stage for each v1 addon with a v2 release, so that each update is its own commit.
 * The v1 addons with no v2 release go in the progress file.
 *
 * @type {import('#types.js').StageGroup}
 */
/**
 * @param {boolean} afterVite
 * @returns {import('#types.js').StageGroup}
 */
function v2AddonsGroup(afterVite) {
  return {
    name: afterVite ? "v2-addons-vite" : "v2-addons",
    label: afterVite
      ? "Move the v1 addons whose components only the Vite build pairs with their templates into the app"
      : "Update each v1 addon that has a v2 release, one commit for each",
    needsInstall: true,

    async expand(project) {
      /** @type {Stage[]} */
      let stages = [];

      /**
       * v2 addons need ember-source 3.28 or newer, and the vite stage stops an older app.
       */
      if (!atLeast(project.dependency("ember-source"), 3, 28)) return stages;
      /** @type {{ name: string, note: string, links: string[] }[]} */
      let v1Only = [];

      /**
       * An addon that moves into the app brings its dependencies to the app's package.json.
       * Its v1 addons get the same treatment, after it.
       *
       * @type {{ name: string, from?: string }[]}
       */
      let queue = installedV1Addons(project).map((name) => ({ name }));
      let seen = new Set(queue.map((entry) => entry.name));

      for (let index = 0; index < queue.length; index++) {
        let { name, from } = queue[index];

        if (IGNORED.has(name) || hasOwnStage(name)) continue;

        let known = NO_V2_YET.get(name);

        if (known) {
          if (!afterVite) v1Only.push({ name, note: known.note, links: known.links });
          continue;
        }

        let release = published(name, MAJOR_CAPS.get(name));
        let inline = release?.v2 ? undefined : inlineV1Stage(project, name, from);

        if (release?.v2) {
          if (!afterVite) stages.push(updateStage(name, release));
        } else if (inline) {
          /**
           * Before the vite stage, the classic build checks each step, and it pairs templates only in app/components.
           */
          if (Boolean(inline.needsVite) !== afterVite) continue;

          stages.push(inline);

          for (let dependency of Object.keys(inline.dependencies)) {
            let directory = dependencyDirectory(inline.directory, dependency);

            if (seen.has(dependency) || !directory || !isV1Addon(directory)) continue;
            if (project.dependency(dependency)) continue;

            seen.add(dependency);
            queue.push({ name: dependency, from: directory });
          }
        } else if (!afterVite) {
          v1Only.push({
            name,
            note: release
              ? `The latest release, ${release.version}, is a v1 addon. Replace it, or help to convert it to a v2 addon.`
              : "The registry does not have this package. Check whether it is a v1 addon that needs conversion.",
            links: release?.repository ? [release.repository] : [],
          });
        }
      }

      if (afterVite) return stages;

      for (let stage of copyUpdates(project)) stages.push(stage);

      if (v1Only.length > 0) stages.push(v1Record(v1Only));

      return stages;
    },
  };
}

/**
 * One stage for each v1 addon with a v2 release, so that each update is its own commit, and the v1 addons
 * that move into the app. The v1 addons with no v2 release go in the progress file.
 */
export const v2Addons = v2AddonsGroup(false);

/**
 * After the vite stage: the v1 addons whose components stay in app/addons with their templates.
 */
export const v2AddonsVite = v2AddonsGroup(true);
