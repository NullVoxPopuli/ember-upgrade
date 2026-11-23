import { findInvocations, rangeOf } from "#codemods/classic-component/invocations.js";
import { moveImports } from "#codemods/move-imports.js";
import { parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { editPackageJson, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";

/**
 * Ember 4 removed `{{#with}}`. It rendered its block only for a truthy value, which `{{#if}}` around `{{#let}}` does.
 * A `{{#with}}` without block params changed the template's context, and stays for the person to change.
 *
 * @param {string} template
 * @returns {string}
 */
export function rewriteWith(template) {
  let output = template;

  for (let round = 0; round < 100; round++) {
    let blocks = findInvocations(output, "with").filter(
      (invocation) => invocation.kind === "block" && invocation.node.program?.blockParams?.length,
    );
    let inner = blocks.find(
      (block) =>
        !blocks.some(
          (other) =>
            other !== block &&
            block.node.start < other.node.start &&
            other.node.end <= block.node.end,
        ),
    );

    if (!inner) return output;

    let node = inner.node;
    let text = (/** @type {import('#ast.js').Node} */ part) => {
      let range = rangeOf(part);

      return output.slice(range.start, range.end);
    };
    let value = node.params.map(text).join(" ");
    let params = node.program.blockParams.join(" ");
    let body = text(node.program);
    let otherwise = node.inverse ? `{{else}}${text(node.inverse)}` : "";
    let range = rangeOf(node);

    output =
      output.slice(0, range.start) +
      `{{#if ${value}}}{{#let ${value} as |${params}|}}${body}{{/let}}${otherwise}{{/if}}` +
      output.slice(range.end);
  }

  return output;
}

/**
 * @param {import('#project.js').Project} project
 */
export function rewriteWithHelpers(project) {
  for (let file of project.files(["{app,addon,tests}/**/*.{hbs,gjs,gts}"])) {
    let source = project.read(file);
    let output = file.endsWith(".hbs")
      ? rewriteWith(source)
      : source.replace(
          /(<template>)([^]*?)(<\/template>)/g,
          (_, open, inner, close) => `${open}${rewriteWith(inner)}${close}`,
        );

    if (output !== source) project.write(file, output);
  }
}

/**
 * @ember/string 4 removed `htmlSafe` and `isHTMLSafe`, which `@ember/template` has had since Ember 3.8.
 *
 * @param {import('#project.js').Project} project
 */
export function moveHtmlSafe(project) {
  for (let file of project.files(["{app,addon,tests}/**/*.{js,ts,gjs,gts}"])) {
    let source = project.read(file);
    let output = moveImports(
      source,
      file,
      "@ember/string",
      "@ember/template",
      (name) => name === "htmlSafe" || name === "isHTMLSafe",
    );

    if (output !== source) project.write(file, output);
  }
}

/**
 * ember-source 7 removed the `inject` export of `@ember/service`. `service` has the same behavior since Ember 4.1.
 *
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
export function useServiceImport(source, file) {
  if (!/\binject\b/.test(source) || !source.includes("@ember/service")) return source;

  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);

  for (let node of program.body) {
    if (node.type !== "ImportDeclaration" || node.source.value !== "@ember/service") continue;

    for (let specifier of node.specifiers) {
      if (specifier.type !== "ImportSpecifier" || specifier.imported.name !== "inject") continue;

      let local = specifier.local.name;

      edits.replace(specifier, local === "service" ? "service" : `service as ${local}`);
    }
  }

  return edits.size > 0 ? edits.apply() : source;
}

/**
 * @param {import('#project.js').Project} project
 */
export function useServiceImports(project) {
  for (let file of project.files(["{app,addon,tests}/**/*.{js,ts,gjs,gts}"])) {
    let source = project.read(file);
    let output = useServiceImport(source, file);

    if (output !== source) project.write(file, output);
  }
}

const LEGACY_ARRAYS = "@nullvoxpopuli/legacy-prototype-extensions";

/**
 * @param {string} config the source of config/environment.js
 * @returns {boolean} the app extends Array.prototype, which Ember did unless EXTEND_PROTOTYPES said otherwise
 */
export function extendsArrays(config) {
  if (/EXTEND_PROTOTYPES\s*:\s*false/.test(config)) return false;

  return !/EXTEND_PROTOTYPES\s*:\s*\{[^}]*\bArray\s*:\s*false/.test(config);
}

/**
 * Ember 6 removed the array prototype extensions, such as `mapBy` and `objectAt` on native arrays.
 * An app that used them gets them back from a library, until its code uses native array methods.
 *
 * @param {import('#project.js').Project} project
 */
export function keepArrayPrototypeExtensions(project) {
  let config = ["config/environment.js", "config/environment.cjs"].find((file) =>
    project.has(file),
  );
  let app = ["app/app.js", "app/app.ts"].find((file) => project.has(file));

  if (!config || !app || !extendsArrays(project.read(config))) return;

  let source = project.read(app);

  if (source.includes(LEGACY_ARRAYS)) return;

  project.write(app, `import "${LEGACY_ARRAYS}/array";\n${source}`);
  editPackageJson(project, (pkg) =>
    setDependency(pkg, LEGACY_ARRAYS, `^${published(LEGACY_ARRAYS)?.version ?? "0.2.0"}`),
  );
  recordProgress(project, {
    id: LEGACY_ARRAYS,
    status: "added",
    note:
      "Ember 6 removed the array prototype extensions, such as mapBy, objectAt, and firstObject on native arrays. " +
      `app.js imports ${LEGACY_ARRAYS}/array, which adds them back. Move the code to native array methods, then remove the import and the package.`,
    links: ["https://deprecations.emberjs.com/id/deprecate-array-prototype-extensions"],
  });
}

/**
 * A controller's `queryParams` is a list. An object, such as `{ addonSortKey: 'sort' }`, worked before Ember 5,
 * and becomes the one entry of the list, which maps the property to its URL name in the same way.
 *
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
export function queryParamsList(source, file) {
  if (!source.includes("queryParams")) return source;

  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);

  walk(program, (node) => {
    let key = node.key?.name ?? node.key?.value;

    if ((node.type !== "PropertyDefinition" && node.type !== "Property") || key !== "queryParams")
      return;
    if (node.value?.type !== "ObjectExpression") return;

    edits.replace(node.value, `[${source.slice(node.value.start, node.value.end)}]`);
  });

  return edits.size > 0 ? edits.apply() : source;
}

/**
 * @param {import('#project.js').Project} project
 */
export function queryParamsLists(project) {
  for (let file of project.files(["app/controllers/**/*.{js,ts}"])) {
    let source = project.read(file);
    let output = queryParamsList(source, file);

    if (output !== source) project.write(file, output);
  }
}

/**
 * The arguments that `<Input>` and `<Textarea>` take in Ember 4. Before, any other argument, such as `@id`
 * or `@placeholder`, set the attribute of the element (deprecation id ember.built-in-components.legacy-arguments).
 */
const BUILT_IN_ARGUMENTS = new Set([
  "@value",
  "@checked",
  "@type",
  "@enter",
  "@insert-newline",
  "@escape-press",
  "@focus-in",
  "@focus-out",
  "@key-up",
  "@key-down",
  "@key-press",
  "@input",
  "@change",
]);

/**
 * @param {string} template
 * @returns {string} the template, with the attributes of `<Input>` and `<Textarea>` as attributes
 */
export function builtInAttributes(template) {
  return template.replace(/<(Input|Textarea)\b[^>]*>/g, (tag) =>
    tag.replace(/(\s)@([\w-]+)=/g, (match, space, name) =>
      BUILT_IN_ARGUMENTS.has(`@${name}`) ? match : `${space}${name === "class" ? "class" : name}=`,
    ),
  );
}

/**
 * @param {import('#project.js').Project} project
 */
export function builtInAttributesInTemplates(project) {
  for (let file of project.files(["{app,addon,tests}/**/*.{hbs,gjs,gts}"])) {
    let source = project.read(file);
    let output = builtInAttributes(source);

    if (output !== source) project.write(file, output);
  }
}
