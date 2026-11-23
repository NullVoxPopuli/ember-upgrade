import { moveImports } from "#codemods/move-imports.js";

const MULTIPLE_IMPORT =
  /^import\s+(\w+)\s+from\s*["']ember-power-select\/components\/power-select-multiple["'];?[ \t]*\n/m;

/**
 * ember-power-select 9 removed the `power-select-multiple` component. `power-select` takes `@multiple={{true}}` instead.
 *
 * @param {string} template
 * @returns {{ template: string, unreadable: string[] }}
 */
export function rewritePowerSelectMultiple(template) {
  let local = MULTIPLE_IMPORT.exec(template)?.[1] ?? "PowerSelectMultiple";
  let imported = MULTIPLE_IMPORT.test(template);
  let hasPowerSelect =
    /import\s+PowerSelect\s+from\s*["']ember-power-select\/components\/power-select["']/.test(
      template,
    );
  let output = template
    .replace(
      MULTIPLE_IMPORT,
      imported && !hasPowerSelect
        ? 'import PowerSelect from "ember-power-select/components/power-select";\n'
        : "",
    )
    .replaceAll(new RegExp(`<${local}(?=[\\s>])`, "g"), "<PowerSelect @multiple={{true}}")
    .replaceAll(`</${local}>`, "</PowerSelect>")
    .replaceAll(/\{\{([#~]*)power-select-multiple(?=[\s}])/g, "{{$1power-select multiple=true")
    .replaceAll(/\{\{(~?)\/power-select-multiple(~?)\}\}/g, "{{$1/power-select$2}}");

  return { template: output, unreadable: [] };
}

/**
 * The helpers that ember-power-select 9 exports from `test-support/helpers`. The others, such as `selectChoose`, come from `test-support`.
 */
const HELPERS = new Set([
  "clickTrigger",
  "findContains",
  "nativeMouseDown",
  "nativeMouseUp",
  "nativeTouch",
  "touchTrigger",
  "triggerKeydown",
  "typeInSearch",
]);

/**
 * @param {string} source a template, or a module
 * @param {string} file
 * @returns {{ template: string, unreadable: string[] }}
 */
export function updatePowerSelect(source, file) {
  let output = /\.(js|ts)$/.test(file) ? source : rewritePowerSelectMultiple(source).template;

  if (/\.(js|ts|gjs|gts)$/.test(file)) {
    output = moveImports(
      output,
      file,
      "ember-power-select/test-support/helpers",
      "ember-power-select/test-support",
      (name) => !HELPERS.has(name),
    );
  }

  return { template: output, unreadable: [] };
}
