import { editPackageJson, removeDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";

const NAME = "ember-power-select-typeahead";
const IMPORT =
  /^import\s+(\w+)\s+from\s*(["'])ember-power-select-typeahead\/components\/power-select-typeahead\2;?[ \t]*\n/m;
const STYLE_IMPORT =
  /^[ \t]*@import\s+["'][^"']*ember-power-select-typeahead[^"']*["'];?[ \t]*\n/gm;
const ARGUMENTS = '@searchEnabled={{true}} @searchFieldPosition="trigger"';

/**
 * @param {string} source a template, or a module with templates
 * @param {string} file
 * @returns {string}
 */
export function replaceTypeahead(source, file) {
  if (/\.(gjs|gts)$/.test(file)) {
    let local = IMPORT.exec(source)?.[1];

    if (!local) return source;

    let existing =
      /^import\s+(\w+)\s+from\s*["']ember-power-select\/components\/power-select["']/m.exec(
        source,
      )?.[1];
    let name = existing ?? "PowerSelect";
    let output = source.replace(
      IMPORT,
      existing ? "" : `import PowerSelect from "ember-power-select/components/power-select";\n`,
    );

    return output
      .replaceAll(`<${local}`, `<${name} ${ARGUMENTS}`)
      .replaceAll(`</${local}>`, `</${name}>`);
  }

  return source
    .replaceAll("<PowerSelectTypeahead", `<PowerSelect ${ARGUMENTS}`)
    .replaceAll("</PowerSelectTypeahead>", "</PowerSelect>")
    .replaceAll(
      "{{#power-select-typeahead",
      '{{#power-select searchEnabled=true searchFieldPosition="trigger"',
    )
    .replaceAll("{{/power-select-typeahead}}", "{{/power-select}}");
}

/**
 * ember-power-select-typeahead is a v1 addon with no v2 release.
 * ember-power-select 8 and later show the search field in the trigger, which is what the typeahead did.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: NAME,
  label: "Replace ember-power-select-typeahead with the trigger search of ember-power-select",

  detect(project) {
    return Boolean(project.dependency(NAME));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    for (let file of project.files(["{app,tests}/**/*.{hbs,gjs,gts}"])) {
      let source = project.read(file);
      let output = replaceTypeahead(source, file);

      if (output !== source) project.write(file, output);
    }

    for (let file of project.files(["app/styles/**/*.{css,scss,sass,less}"])) {
      let source = project.read(file);
      let output = source.replace(STYLE_IMPORT, "");

      if (output !== source) project.write(file, output);
    }

    editPackageJson(project, (pkg) => removeDependency(pkg, NAME));
    recordProgress(project, {
      id: NAME,
      status: "removed",
      note:
        'ember-power-select-typeahead is replaced by ember-power-select with @searchEnabled and @searchFieldPosition="trigger". ' +
        "Its styles are gone. Check the look of the search field in the trigger.",
      links: ["https://ember-power-select.com/docs/the-search"],
    });

    return [];
  },
};
