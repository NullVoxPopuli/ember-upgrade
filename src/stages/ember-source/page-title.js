/**
 * ember-page-title 6 renamed the `title` helper to `page-title`.
 * Only a call with arguments is the helper: before the no-implicit-this stage, `{{title}}` reads a property.
 */
const TITLE_CALL = /\{\{(~?)title(\s+)(?=["'@(\w])/g;

/**
 * @param {string} template
 * @returns {string}
 */
export function renameTitleHelper(template) {
  return template.replaceAll(TITLE_CALL, "{{$1page-title$2");
}

/**
 * @param {import('#project.js').Project} project
 */
export function renameTitleHelpers(project) {
  for (let file of project.files(["{app,addon,lib}/**/*.hbs"])) {
    let source = project.read(file);
    let renamed = renameTitleHelper(source);

    if (renamed !== source) project.write(file, renamed);
  }
}
