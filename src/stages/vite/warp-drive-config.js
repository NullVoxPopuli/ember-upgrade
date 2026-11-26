import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseProgram, walk } from "#ast.js";
import { buildFile } from "#config-files.js";
import { Edits } from "#edits.js";
import { resolvePackage } from "#installed.js";
import { editPackageJson, setDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";
import { atLeast } from "#version.js";

/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#ast.js').Node} Node */

const PACKAGE = "@warp-drive/build-config";

/**
 * The call of the app blueprints of ember-source 6. In the ember-cli build, ember-data's addon set the config,
 * and compatBuild needs the app to set it.
 */
const CALL = `
  const { setConfig } = await import('${PACKAGE}');
  setConfig(app, __dirname, {});`;

/**
 * @param {string} source ember-cli-build
 * @param {string} file
 * @returns {string} the same source when it calls setConfig, has no `new EmberApp()` in an async function, or does not parse
 */
export function withWarpDriveConfig(source, file) {
  if (source.includes("setConfig(")) return source;

  let program = parseProgram(source, file);
  /** @type {{ end: number, name: string } | undefined} */
  let app;
  let async = false;

  walk(program, (node, parent) => {
    if (
      (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") &&
      node.async
    )
      async = true;

    if (
      !app &&
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "NewExpression" &&
      node.init.callee.name === "EmberApp" &&
      parent?.type === "VariableDeclaration"
    ) {
      app = { end: parent.end, name: node.id.name };
    }
  });

  if (!app || !async) return source;

  let found = /** @type {{ end: number, name: string }} */ (app);
  let edits = new Edits(source);

  edits.insert(found.end, CALL.replace("setConfig(app,", `setConfig(${found.name},`));

  return edits.apply();
}

/**
 * ember-data 5 builds its code with the config that `setConfig()` of @warp-drive/build-config gives.
 *
 * @param {Project} project
 */
export function addWarpDriveConfig(project) {
  let file = buildFile(project);

  if (!file || !atLeast(project.dependency("ember-data"), 5, 0)) return;

  let source = project.read(file);
  let output = withWarpDriveConfig(source, file);

  if (output === source) return;

  project.write(file, output);

  let emberData = resolvePackage(project.directory, "ember-data");
  let config = emberData ? resolvePackage(emberData, PACKAGE) : undefined;
  let version = config
    ? JSON.parse(readFileSync(join(config, "package.json"), "utf8")).version
    : undefined;

  editPackageJson(project, (pkg) => {
    if (!project.dependency(PACKAGE)) {
      setDependency(
        pkg,
        PACKAGE,
        version ? `^${version}` : String(project.dependency("ember-data")),
      );
    }
  });

  recordProgress(project, {
    id: `${PACKAGE}: setConfig`,
    status: "added",
    note:
      `ember-cli-build calls setConfig() of ${PACKAGE}, as the app blueprints of ember-source 6 do. ` +
      "Set `compatWith` and the deprecations that the app has resolved there.",
    links: ["https://docs.warp-drive.io/api/@warp-drive/core/build-config/"],
  });
}
