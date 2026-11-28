import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { parseProgram } from "#ast.js";
import { Edits } from "#edits.js";
import { modulePrefix } from "#module-prefix.js";
import { templateNames } from "#stages/dynamic-components/names.js";
import { addonCalls } from "#stages/missing-components/index.js";

/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#ast.js').Node} Node */

/**
 * @typedef {object} AddonComponent
 * @property {string} call the name that templates call, such as `vertical-collection`
 * @property {string} from the package, such as `@html-next/vertical-collection`
 * @property {string} exported the named export of the package entry, such as `VerticalCollection`
 */

/**
 * @param {string} call
 * @returns {string} `vertical-collection` as `VerticalCollection`
 */
function pascalCase(call) {
  return call
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * @param {Record<string, any>} manifest
 * @returns {string | undefined} the file of the package entry, relative to the package
 */
function entryFile(manifest) {
  let entry = manifest.exports?.["."] ?? manifest.exports;

  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    let path = entry.import ?? entry.default ?? entry.module;

    if (typeof path === "string") return path;
  }

  return manifest.module ?? manifest.main;
}

/**
 * @param {string} source
 * @returns {Set<string>} the names that a built module exports
 */
function exportNames(source) {
  /** @type {Set<string>} */
  let names = new Set();

  for (let match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (let part of String(match[1]).split(",")) {
      let name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();

      if (name) names.add(name);
    }
  }

  for (let match of source.matchAll(/export\s+(?:class|const|let|var|function)\s+([\w$]+)/g)) {
    names.add(String(match[1]));
  }

  return names;
}

/**
 * The components that templates call by an addon's name, which the v2 release of the addon
 * no longer puts in the app, and exports from its package entry instead, such as
 * `{{#vertical-collection}}` and `VerticalCollection` from @html-next/vertical-collection 6.
 *
 * @param {Project} project
 * @returns {AddonComponent[]}
 */
export function addonComponents(project) {
  let names = templateNames(project);

  if (!names) return [];

  /** @type {Set<string>} */
  let calls = new Set();

  for (let file of project.files(["app/**/*.hbs"])) {
    for (let call of addonCalls(project.read(file), names)) calls.add(call);
  }

  /** @type {AddonComponent[]} */
  let found = [];

  for (let call of Array.from(calls).sort()) {
    if (call.includes("/")) continue;

    let addon = names.packages.find((candidate) => {
      let unscoped = candidate.name.replace(/^@[^/]+\//, "");

      return call === unscoped || call.startsWith(`${unscoped}-`);
    });

    if (!addon || addon.manifest["ember-addon"]?.version !== 2) continue;

    let entry = entryFile(addon.manifest);
    let file = entry && join(addon.directory, entry);

    if (!file || !existsSync(file)) continue;

    let exported = pascalCase(call);

    if (exportNames(readFileSync(file, "utf8")).has(exported)) {
      found.push({ call, from: addon.name, exported });
    }
  }

  return found;
}

/**
 * @param {AddonComponent} component
 */
function shimFile(component) {
  return `app/components/${component.call}.js`;
}

/**
 * The template-tag codemod resolves a template's names through the app's components,
 * and imports only default exports, so a re-export lets it find the addon's component.
 *
 * @param {Project} project
 * @param {AddonComponent[]} components
 */
export function writeShims(project, components) {
  for (let component of components) {
    project.write(
      shimFile(component),
      `export { ${component.exported} as default } from "${component.from}";\n`,
    );
  }
}

/**
 * Replaces the codemod's imports of each re-export with a named import from the addon, and removes the re-exports.
 *
 * @param {Project} project
 * @param {AddonComponent[]} components
 */
export function replaceShims(project, components) {
  if (components.length === 0) return;

  let prefix = modulePrefix(project);
  /** @type {Map<string, AddonComponent>} */
  let byModule = new Map(
    components.map((component) => [shimFile(component).replace(/\.js$/, ""), component]),
  );

  for (let file of project.files(["{app,tests}/**/*.{js,ts,gjs,gts}"])) {
    let source = project.read(file);

    if (!components.some((component) => source.includes(component.call))) continue;

    let program = parseProgram(source, file);

    if (!program) continue;

    let edits = new Edits(source);

    for (let node of /** @type {Node[]} */ (program.body)) {
      if (node.type !== "ImportDeclaration" || node.specifiers.length !== 1) continue;

      let [specifier] = node.specifiers;

      if (specifier.type !== "ImportDefaultSpecifier") continue;

      let path = String(node.source.value).replace(/\.js$/, "");
      let module = path.startsWith(".")
        ? relative(project.directory, join(project.directory, dirname(file), path))
            .split("\\")
            .join("/")
        : path.replace(new RegExp(`^${prefix}/`), "app/");
      let component = byModule.get(module);

      if (!component) continue;

      let local = specifier.local.name;
      let named = local === component.exported ? local : `${component.exported} as ${local}`;

      edits.replace(node, `import { ${named} } from "${component.from}";`);
    }

    let output = edits.apply();

    if (output !== source) project.write(file, output);
  }

  for (let component of components) {
    rmSync(join(project.directory, shimFile(component)), { force: true });
  }
}
