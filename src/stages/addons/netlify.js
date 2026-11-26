import { rmSync } from "node:fs";
import { join } from "node:path";

import { parseProgram, propertyName, walk } from "#ast.js";
import { buildFile, removeBuildOptions } from "#config-files.js";
import { installedAddonTree } from "#installed.js";
import { editPackageJson, removeDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#ast.js').Node} Node */

const NAME = "ember-cli-netlify";

/**
 * The dotfiles that ember-cli-netlify copied into dist/, and where Vite copies them from now.
 */
const FILES = [
  { from: ".netlifyheaders", to: "public/_headers" },
  { from: ".netlifyredirects", to: "public/_redirects" },
];

/**
 * @param {Project} project
 * @returns {string[] | undefined} the `redirects` of the ember-cli-netlify option; undefined when one is not a string
 */
function optionRedirects(project) {
  let file = buildFile(project);
  let program = file ? parseProgram(project.read(file), file) : undefined;
  /** @type {string[]} */
  let redirects = [];
  let readable = true;

  walk(program, (node) => {
    if (node.type !== "NewExpression") return;

    for (let property of node.arguments[1]?.properties ?? []) {
      if (propertyName(property) !== NAME) continue;

      for (let option of property.value.properties ?? []) {
        if (propertyName(option) !== "redirects") continue;

        for (let element of option.value.elements ?? []) {
          if (element?.type === "Literal" && typeof element.value === "string") {
            redirects.push(element.value);
          } else {
            readable = false;
          }
        }
      }
    }
  });

  return readable ? redirects : undefined;
}

/**
 * ember-cli-netlify copied `.netlifyheaders` and `.netlifyredirects` into dist/ after the ember-cli build,
 * and added the `redirects` of its option. Vite copies public/ into dist/, so the files move there.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: NAME,
  label: "Replace ember-cli-netlify with public/_headers and public/_redirects",

  detect(project) {
    return Boolean(project.dependency(NAME));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    /** @type {import('#types.js').Finding[]} */
    let todo = [];
    let redirects = optionRedirects(project);
    let plugins = installedAddonTree(project)
      .filter(({ manifest }) => manifest.keywords?.includes("ember-cli-netlify-plugin"))
      .map(({ manifest }) => manifest.name);

    for (let { from, to } of FILES) {
      if (!project.has(from)) continue;

      project.write(to, project.read(from));
      rmSync(join(project.directory, from));
    }

    if (redirects === undefined) {
      todo.push({
        title: "Move the redirects of the ember-cli-netlify option to public/_redirects",
        where: [buildFile(project) ?? "ember-cli-build.js"],
        action: "Write each redirect on its own line of public/_redirects.",
      });
    } else if (redirects.length > 0) {
      let existing = project.has("public/_redirects") ? project.read("public/_redirects") : "";
      let separator = existing === "" || existing.endsWith("\n") ? "" : "\n";

      project.write("public/_redirects", `${existing}${separator}${redirects.join("\n")}\n`);
    }

    if (plugins.length > 0) {
      todo.push({
        title: `Write the redirects of ${plugins.join(", ")} to public/_redirects`,
        where: ["public/_redirects"],
        action: "These addons gave ember-cli-netlify their redirects in the build.",
      });
    }

    removeBuildOptions(project, [NAME]);
    editPackageJson(project, (pkg) => removeDependency(pkg, NAME));

    recordProgress(project, {
      id: NAME,
      status: "removed",
      note:
        "ember-cli-netlify is removed. public/_headers and public/_redirects hold what it copied into dist/, " +
        "and Vite copies public/ into dist/.",
      links: ["https://docs.netlify.com/routing/redirects/"],
    });

    return todo;
  },
};
