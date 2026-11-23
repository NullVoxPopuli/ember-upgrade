import { findInvocations, rangeOf } from "#codemods/classic-component/invocations.js";
import { moveImports } from "#codemods/move-imports.js";
import { parseProgram } from "#ast.js";
import { Edits } from "#edits.js";

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
