import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseProgram, propertyName, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { installedAddonTree } from "#installed.js";
import { isV1Addon } from "#stages/addons/known.js";

/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#ast.js').Node} Node */

/**
 * @param {Project} project
 * @returns {string[]} the v1 addons that write the app's config module with `contentFor('config-module')`, such as ember-cli-fastboot
 */
export function configModuleAddons(project) {
  return installedAddonTree(project)
    .filter(({ directory, manifest }) => {
      if (!isV1Addon(manifest)) return false;

      let main = join(directory, manifest["ember-addon"]?.main ?? "index.js");
      let file = existsSync(main) ? main : `${main}.js`;

      return existsSync(file) && readFileSync(file, "utf8").includes("config-module");
    })
    .map(({ manifest }) => manifest.name)
    .sort();
}

/**
 * Embroider stops on a config module from an addon. The app's config/environment module, which ember-vite-codemod
 * writes, reads the same meta tag, and `useAddonConfigModule: false` makes compatBuild use it.
 *
 * @param {string} source ember-cli-build
 * @param {string} file
 * @returns {string} the same source when compatBuild already has the option, or no call
 */
export function withoutAddonConfigModule(source, file) {
  let program = parseProgram(source, file);
  let edits = new Edits(source);

  walk(program, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "Identifier" ||
      node.callee.name !== "compatBuild" ||
      node.arguments.length < 2
    ) {
      return;
    }

    let options = node.arguments[2];

    if (!options) {
      edits.insert(node.arguments[1].end, ", { useAddonConfigModule: false }");
    } else if (
      options.type === "ObjectExpression" &&
      !options.properties.some(
        (/** @type {Node} */ property) => propertyName(property) === "useAddonConfigModule",
      )
    ) {
      edits.insert(options.start + 1, " useAddonConfigModule: false,");
    }
  });

  return edits.size > 0 ? edits.apply() : source;
}
