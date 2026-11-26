import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseProgram, propertyName, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { installedAddonTree } from "#installed.js";
import { isV1Addon } from "#stages/addons/known.js";

/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#ast.js').Node} Node */

/**
 * The parts of the app that a v1 addon can write with `contentFor`, and the compatBuild option that makes Embroider use the app's own.
 * The app's config/environment module reads the config meta tag, and index.html boots the app.
 */
export const ADDON_CONTENT = [
  { content: "config-module", option: "useAddonConfigModule" },
  { content: "app-boot", option: "useAddonAppBoot" },
];

/**
 * @param {Project} project
 * @param {string} content such as `config-module`
 * @returns {string[]} the v1 addons that write that part of the app with `contentFor`, such as ember-cli-fastboot
 */
export function contentAddons(project, content) {
  return installedAddonTree(project)
    .filter(({ directory, manifest }) => {
      if (!isV1Addon(manifest)) return false;

      let main = join(directory, manifest["ember-addon"]?.main ?? "index.js");
      let file = existsSync(main) ? main : `${main}.js`;
      let text = existsSync(file) ? readFileSync(file, "utf8") : "";

      return text.includes(`'${content}'`) || text.includes(`"${content}"`);
    })
    .map(({ manifest }) => manifest.name)
    .sort();
}

/**
 * Embroider stops on the parts of the app that addons write with `contentFor`, such as the config module.
 *
 * @param {string} source ember-cli-build
 * @param {string} file
 * @param {string} [option] the compatBuild option that turns the addon's part off
 * @returns {string} the same source when compatBuild already has the option, or no call
 */
export function withoutAddonConfigModule(source, file, option = "useAddonConfigModule") {
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
      edits.insert(node.arguments[1].end, `, { ${option}: false }`);
    } else if (
      options.type === "ObjectExpression" &&
      !options.properties.some(
        (/** @type {Node} */ property) => propertyName(property) === "useAddonConfigModule",
      )
    ) {
      edits.insert(options.start + 1, ` ${option}: false,`);
    }
  });

  return edits.size > 0 ? edits.apply() : source;
}
