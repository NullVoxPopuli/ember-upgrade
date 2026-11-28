/** @typedef {import('#project.js').Project} Project */

const TEMPLATES = ["{app,addon,tests}/**/*.hbs"];

/**
 * A `<` that does not start a tag, a closing tag, a comment, an argument or a named block.
 * HTML shows it as text. Glimmer reads every `<` as a tag and stops on it.
 */
const STRAY = /<(?![A-Za-z!/@:])/g;

/**
 * Mustaches, including comments and triple curlies, whose `<` is not template text.
 */
const MUSTACHE = /\{\{!--[^]*?--\}\}|\{\{[^]*?\}\}/g;

/**
 * @param {string} template
 * @returns {string} the template, with each stray `<` outside mustaches as `&lt;`
 */
export function escapeStrayLessThan(template) {
  let output = "";
  let last = 0;

  for (let match of template.matchAll(MUSTACHE)) {
    let index = /** @type {number} */ (match.index);

    output += template.slice(last, index).replace(STRAY, "&lt;") + match[0];
    last = index + match[0].length;
  }

  return output + template.slice(last).replace(STRAY, "&lt;");
}

/**
 * Older Ember versions showed a stray `<` in a template as text, as HTML does.
 * The template compiler of newer versions, and the codemods after this stage, fail on it.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "template-text",
  label: "Escape each `<` in template text that does not start a tag",

  detect(project) {
    return project
      .files(TEMPLATES)
      .some((file) => escapeStrayLessThan(project.read(file)) !== project.read(file));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    for (let file of project.files(TEMPLATES)) {
      let source = project.read(file);
      let output = escapeStrayLessThan(source);

      if (output !== source) project.write(file, output);
    }

    return [];
  },
};
