import { findInvocations, rangeOf } from "#codemods/classic-component/invocations.js";
import { moveImports } from "#codemods/move-imports.js";

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
