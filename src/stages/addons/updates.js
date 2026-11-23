import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProgram } from "#ast.js";
import { addVitePlugin, removeBuildOptions, viteConfig } from "#config-files.js";
import { Edits } from "#edits.js";
import { allowBuild, overrideRange, removeOverride } from "#manager-settings.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { packageManager, published, runUpstream } from "#process.js";
import { readProgress, recordProgress } from "#progress.js";
import { atLeast, minorOf } from "#version.js";
import { rewriteClickOutside } from "./click-outside.js";
import { updatePowerSelect } from "./power-select.js";
import { dependencyDirectory, inlineV1Stage } from "./inline-v1.js";
import { isObsoleteAddon } from "./removals.js";
import { IGNORED, NO_V2_YET, installedV1Addons } from "./known.js";
import { ICONS_MODULE, iconsModule, rewriteDynamicIcons } from "./svg-jar-icons.js";

/** @typedef {import('#types.js').Stage} Stage */
/** @typedef {import('#types.js').Finding} Finding */

const APP_FILES = ["app/app.js", "app/app.ts"];
const WORKFLOW = "app/deprecation-workflow.js";
const OLD_WORKFLOW = "config/deprecation-workflow.js";

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
const STYLEGUIDE_REF =
  "github:NullVoxPopuli-ai-agent/ember-styleguide#13c541632cb2adb728db69bf8abc852e7777562e";

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
      return [];
    }

    editPackageJson(project, (pkg) => setDependency(pkg, "ember-styleguide", STYLEGUIDE_REF));

    if (packageManager(project) === "pnpm") allowBuild(project, "ember-styleguide");

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
    ].includes(name)
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
       */
      let wanted = Object.assign({}, release.dependencies, release.peerDependencies, {
        [name]: `^${release.version}`,
      });
      /** @type {string[]} */
      let unpinned = [];

      for (let [dependency, range] of Object.entries(wanted)) {
        let pin = overrideRange(project, dependency);

        if (pin && olderRelease(pin, range)) {
          removeOverride(project, dependency);
          unpinned.push(`${dependency} (${pin}, and ${name} ${release.version} asks for ${range})`);
        }
      }

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
       * The vite-sass stage pointed Sass imports at the v1 addon's app/styles, which a v2 addon does not have.
       * Its package entry has the styles, through the `sass` export condition.
       */
      let escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      let stylePath = new RegExp(`(["'])${escaped}/app/styles/[^"']+\\1`, "g");

      for (let file of project.files(["app/styles/**/*.{scss,sass}"])) {
        let source = project.read(file);
        let output = source.replace(stylePath, `$1${name}$1`);

        if (output !== source) project.write(file, output);
      }

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
          status: "removed",
          note:
            `package.json forced versions that ${name} ${release.version} does not accept, so they are gone: ` +
            `${unpinned.join(", ")}.`,
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
]);

/**
 * The highest major version that the update of an addon goes to, when a later stage does the next major.
 * ember-concurrency 5 runs only the tasks of native classes, so the ember-concurrency stage updates to it after classic-components.
 */
const MAJOR_CAPS = new Map([["ember-concurrency", "4"]]);

/**
 * One stage for each v1 addon with a v2 release, so that each update is its own commit.
 * The v1 addons with no v2 release go in the progress file.
 *
 * @type {import('#types.js').StageGroup}
 */
export const v2Addons = {
  name: "v2-addons",
  label: "Update each v1 addon that has a v2 release, one commit for each",
  needsInstall: true,

  async expand(project) {
    /** @type {Stage[]} */
    let stages = [];
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
        v1Only.push({ name, note: known.note, links: known.links });
        continue;
      }

      let release = published(name, MAJOR_CAPS.get(name));
      let inline = release?.v2 ? undefined : inlineV1Stage(project, name, from);

      if (release?.v2) {
        stages.push(updateStage(name, release));
      } else if (inline) {
        stages.push(inline);

        for (let dependency of Object.keys(inline.dependencies)) {
          let directory = dependencyDirectory(inline.directory, dependency);

          if (seen.has(dependency) || !directory || !isV1Addon(directory)) continue;
          if (project.dependency(dependency)) continue;

          seen.add(dependency);
          queue.push({ name: dependency, from: directory });
        }
      } else {
        v1Only.push({
          name,
          note: release
            ? `The latest release, ${release.version}, is a v1 addon. Replace it, or help to convert it to a v2 addon.`
            : "The registry does not have this package. Check whether it is a v1 addon that needs conversion.",
          links: release?.repository ? [release.repository] : [],
        });
      }
    }

    if (v1Only.length > 0) stages.push(v1Record(v1Only));

    return stages;
  },
};
