import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { resolvePackage } from "#installed.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { install, published } from "#process.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const NAME = "@percy/ember";
const HELPER = "tests/helpers/percy.js";
const SOURCE = "addon-test-support/@percy/ember/index.js";
const ENV_IMPORT = /^import SDKENV from ['"]@percy\/ember\/env['"];?$/m;
const IMPORT = /(from\s*|import\s*)(['"])@percy\/ember\2/g;

/**
 * @param {string} helper the source of the addon's test helper
 * @param {string} version the version of @percy/ember
 * @returns {string | undefined} the helper without the module that the addon's build wrote; undefined when it has no such import
 */
export function percyHelper(helper, version) {
  if (!ENV_IMPORT.test(helper)) return;

  /**
   * The addon's build wrote its version and the PERCY_SERVER_ADDRESS of the build environment.
   * Without an address, @percy/sdk-utils reaches the Percy CLI at its default address.
   */
  return helper.replace(
    ENV_IMPORT,
    `const SDKENV = { VERSION: ${JSON.stringify(version)}, PERCY_SERVER_ADDRESS: undefined };`,
  );
}

/**
 * @param {string} file a test module, such as `tests/acceptance/index-test.js`
 * @returns {string} the import of the helper from that module
 */
function helperImport(file) {
  let path = relative(dirname(file), HELPER).split("\\").join("/").replace(/\.js$/, "");

  return path.startsWith(".") ? path : `./${path}`;
}

/**
 * @param {Project} project
 * @returns {{ directory: string, version: string, helper: string } | undefined}
 */
function installedPercy(project) {
  let directory = resolvePackage(project.directory, NAME);

  if (!directory || !existsSync(join(directory, SOURCE))) return;

  let version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
  let helper = percyHelper(readFileSync(join(directory, SOURCE), "utf8"), version);

  return helper ? { directory, version, helper } : undefined;
}

/**
 * @percy/ember is a v1 addon whose only module is a test helper around @percy/sdk-utils.
 * The helper moves into the app's tests, which import it from there.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "percy-ember",
  label: "Move the test helper of @percy/ember, a v1 addon, into tests/helpers/percy.js",
  needsInstall: true,

  detect(project) {
    return Boolean(project.dependency(NAME));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    /** @type {import('#types.js').Finding[]} */
    let todo = [];
    let percy = installedPercy(project);

    /**
     * Before 5, the helper had another shape. Its API, `percySnapshot(name, options)`, is the same.
     */
    if (!percy) {
      editPackageJson(project, (pkg) =>
        setDependency(pkg, NAME, `^${published(NAME)?.version ?? "5.0.1"}`),
      );

      if (!install(project)) throw new Error(`The install of the latest ${NAME} failed.`);

      percy = installedPercy(project);
    }

    if (!percy) throw new Error(`${NAME} has no ${SOURCE}. Move its test helper by hand.`);

    if (!project.dependency("@percy/cli")) {
      todo.push({
        title: "Run the Percy tests with @percy/cli",
        where: ["package.json"],
        action: `${NAME} 5 sends the snapshots to @percy/cli, which replaced @percy/agent. Run the tests with \`percy exec -- <test command>\`.`,
      });
    }

    let utils = resolvePackage(percy.directory, "@percy/sdk-utils");
    let range = utils
      ? `^${JSON.parse(readFileSync(join(utils, "package.json"), "utf8")).version}`
      : `^${published("@percy/sdk-utils")?.version ?? "1.31.0"}`;

    project.write(HELPER, percy.helper);

    for (let file of project.files(["tests/**/*.{js,ts,gjs,gts}"])) {
      if (file === HELPER) continue;

      let source = project.read(file);
      let output = source.replace(
        IMPORT,
        (_, keyword, quote) => `${keyword}${quote}${helperImport(file)}${quote}`,
      );

      if (output !== source) project.write(file, output);
    }

    editPackageJson(project, (pkg) => {
      removeDependency(pkg, NAME);

      if (!project.dependency("@percy/sdk-utils")) setDependency(pkg, "@percy/sdk-utils", range);
    });

    recordProgress(project, {
      id: NAME,
      status: "moved into the app",
      note:
        `${NAME} is a v1 addon with no v2 release, and its only module is a test helper. It is in ${HELPER} now. ` +
        "Its build read PERCY_SERVER_ADDRESS. If CI sets that variable, set `utils.percy.address` in the helper.",
      links: ["https://github.com/percy/ember-percy"],
    });

    return todo;
  },
};
