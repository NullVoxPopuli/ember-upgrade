import { posix } from "node:path";

import { convertComponents } from "#codemods/classic-component/convert.js";
import { modulePrefix } from "#module-prefix.js";
import { editPackageJson, setDependency } from "#package-json.js";
import { readProgress, recordProgress } from "#progress.js";

const FILES = ["app/**/*.hbs", "app/components/**/*.js", "app/components/**/*.ts"];

/**
 * The ranges for the packages that Glimmer components import.
 */
const PACKAGES = new Map([
  ["@glimmer/component", "^2.2.1"],
  ["@glimmer/tracking", "^1.1.2"],
  ["ember-modifier", "^4.3.0"],
]);

/**
 * @param {import('#project.js').Project} project
 * @returns {Map<string, string>}
 */
function sources(project) {
  return new Map(project.files(FILES).map((file) => [file, project.read(file)]));
}

/**
 * @param {import('#project.js').Project} project
 * @returns {import('#codemods/classic-component/mixins.js').Resolve}
 */
function resolver(project) {
  let prefix = `${modulePrefix(project)}/`;

  return (specifier, from) => {
    let path;

    if (specifier.startsWith(prefix)) path = `app/${specifier.slice(prefix.length)}`;
    else if (specifier.startsWith(".")) path = posix.join(posix.dirname(from), specifier);
    else return;

    for (let file of [`${path}.js`, `${path}.ts`, `${path}/index.js`, `${path}/index.ts`]) {
      if (project.has(file)) return { file, source: project.read(file) };
    }
  };
}

/**
 * Classic components (`@ember/component`) stop the template-tag codemod when they take positional
 * arguments, and ember.nvp supports only Glimmer components.
 * The conversion follows the Octane upgrade guide: the element moves into the template,
 * arguments come from `this.args`, own state is `@tracked`, element hooks run from a modifier,
 * and callers use angle brackets.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "classic-components",
  label: "Convert classic components into Glimmer components",

  detect(project) {
    /**
     * Components that the conversion cannot read stay, so the progress entry shows that it ran.
     */
    if (readProgress(project).some((entry) => entry.id === "classic-components")) return false;

    return project
      .files(["app/components/**/*.js", "app/components/**/*.ts"])
      .some((file) => /@ember\/component['"]/.test(project.read(file)));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let conversion = convertComponents(sources(project), { resolve: resolver(project) });

    for (let [file, contents] of conversion.files) project.write(file, contents);

    let imports = Array.from(conversion.files.values()).join("\n");

    editPackageJson(project, (pkg) => {
      for (let [name, range] of PACKAGES) {
        let needed = imports.includes(`'${name}'`) || imports.includes(`"${name}"`);

        if (needed && !project.dependency(name)) setDependency(pkg, name, range);
      }
    });

    let converted = Array.from(conversion.files.keys()).filter((file) => /\.(js|ts)$/.test(file));

    recordProgress(project, {
      id: "classic-components",
      status: "changed",
      note: `${converted.length} classic components are Glimmer components now. ${conversion.skipped.length} stay classic.`,
      links: ["https://guides.emberjs.com/v5.12.0/upgrading/current-edition/glimmer-components/"],
    });

    return conversion.skipped.length > 0
      ? [
          {
            title: "Classic components that the conversion did not change",
            where: conversion.skipped.map(({ file, reasons }) => `${file}: ${reasons.join("; ")}`),
            action:
              "Convert each one into a Glimmer component, as the Octane upgrade guide shows. ember.nvp supports only Glimmer components.",
          },
        ]
      : [];
  },
};
