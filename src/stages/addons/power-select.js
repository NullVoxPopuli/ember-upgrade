import { join } from "node:path";

import { identifierName, parseProgram, walk } from "#ast.js";
import { moveImports } from "#codemods/move-imports.js";
import { Edits } from "#edits.js";

/** @typedef {import("#ast.js").Node} Node */

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
  /** @type {string[]} */
  let unreadable = [];

  /**
   * ember-power-select 8 renamed the helper. It checks the same, for native arrays.
   */
  if (/\bemberPowerSelectIsSelected\b/.test(output)) {
    unreadable.push(
      "emberPowerSelectIsSelected is the default export of ember-power-select/helpers/ember-power-select-is-equal now",
    );
  } else {
    output = output.replace(IS_SELECTED, "ember-power-select-is-equal");
  }

  if (/\.(js|ts|gjs|gts)$/.test(file)) {
    output = moveImports(
      output,
      file,
      "ember-power-select/test-support/helpers",
      "ember-power-select/test-support",
      (name) => !HELPERS.has(name),
    );
  }

  return { template: output, unreadable };
}

const IS_SELECTED = /\bember-power-select-is-selected\b(?!-)/g;

const WORMHOLE_IMPORT =
  "import BasicDropdownWormhole from 'ember-basic-dropdown/components/basic-dropdown-wormhole';";

/**
 * ember-basic-dropdown 8 and later render dropdowns into `<BasicDropdownWormhole />`, which the app's
 * application template has. Before, the addon added its element to index.html with contentFor.
 *
 * @param {import('#project.js').Project} project
 */
export function addBasicDropdownWormhole(project) {
  let file = [
    "app/templates/application.gjs",
    "app/templates/application.gts",
    "app/templates/application.hbs",
  ].find((name) => project.has(name));

  if (!file) {
    if (!project.has("app/app.js") && !project.has("app/app.ts")) return;

    project.write("app/templates/application.hbs", "{{outlet}}\n<BasicDropdownWormhole />\n");
    return;
  }

  let source = project.read(file);

  if (source.includes("BasicDropdownWormhole")) return;

  if (file.endsWith(".hbs")) {
    project.write(file, `${source.replace(/\n?$/, "\n")}<BasicDropdownWormhole />\n`);
    return;
  }

  let close = source.lastIndexOf("</template>");

  if (close === -1) return;

  project.write(
    file,
    `${WORMHOLE_IMPORT}\n${source.slice(0, close)}<BasicDropdownWormhole />\n${source.slice(close)}`,
  );
}

/**
 * The block of each `<PowerSelect>` and `{{#power-select}}`, which renders inside an option.
 */
const OPTION_BLOCKS = [
  /<PowerSelect(?:Multiple)?\b[^>]*>([\s\S]*?)<\/PowerSelect(?:Multiple)?>/g,
  /\{\{#power-select(?:-multiple)?\b[^}]*\}\}([\s\S]*?)\{\{\/power-select(?:-multiple)?\}\}/g,
];

/**
 * @param {import('#project.js').Project} project
 * @returns {Set<string>} the classes of the elements in the options of the app's power-selects
 */
export function optionClasses(project) {
  /** @type {Set<string>} */
  let classes = new Set();

  for (let file of project.files(["{app,addon}/**/*.{hbs,gjs,gts}"])) {
    for (let pattern of OPTION_BLOCKS) {
      for (let block of project.read(file).matchAll(pattern)) {
        for (let attribute of block[1].matchAll(/\bclass="([^"{]*)/g)) {
          for (let name of attribute[1].split(/\s+/)) if (name) classes.add(name);
        }
      }
    }
  }

  return classes;
}

const CLICK_NOTE =
  "/** click() renders between mouseup and click. PowerSelect closes on mouseup, so a full click reaches a removed element. */";

/**
 * Changes `click(target)` to `triggerEvent(target, 'click')` in tests, for the elements in power-select options.
 * `click()` of @ember/test-helpers 5 renders after mouseup, when PowerSelect closed the list, and the click
 * reaches a link that is not in the page any more. The browser then leaves the test page.
 *
 * @param {string} source a test module
 * @param {string} file
 * @param {Set<string>} classes from `optionClasses`
 * @returns {string | undefined}
 */
export function withOptionClicks(source, file, classes) {
  if (classes.size === 0 || !source.includes("@ember/test-helpers")) return;

  let program = parseProgram(source, file);

  if (!program) return;

  let helpers = program.body.find(
    (/** @type {Node} */ node) =>
      node.type === "ImportDeclaration" && node.source.value === "@ember/test-helpers",
  );
  let click = helpers?.specifiers.find(
    (/** @type {Node} */ s) => s.type === "ImportSpecifier" && s.imported.name === "click",
  );

  if (!helpers || !click) return;

  let local = click.local.name;
  let trigger =
    helpers.specifiers.find(
      (/** @type {Node} */ s) => s.type === "ImportSpecifier" && s.imported.name === "triggerEvent",
    )?.local.name ?? "triggerEvent";
  let edits = new Edits(source);
  let left = 0;

  walk(program, (node, parent) => {
    if (node.type !== "CallExpression" || identifierName(node.callee) !== local) return;

    let target = node.arguments[0];
    /** @type {string[]} */
    let selectors = [];

    walk(target, (child) => {
      if (child.type === "Literal" && typeof child.value === "string") selectors.push(child.value);
    });

    let option = selectors.some((selector) =>
      Array.from(selector.matchAll(/\.([\w-]+)/g)).some((match) => classes.has(match[1])),
    );

    if (!option || node.arguments.length !== 1) {
      left++;
      return;
    }

    edits.replace(node.callee, trigger);
    edits.insert(target.end, ", 'click'");

    let statement = parent?.type === "AwaitExpression" ? parent : node;
    let lineStart = source.lastIndexOf("\n", statement.start - 1) + 1;
    let indent = source.slice(lineStart, statement.start);

    if (indent.trim() === "") edits.insert(lineStart, `${indent}${CLICK_NOTE}\n`);
  });

  if (edits.size === 0) return;

  let rest = helpers.specifiers
    .filter((/** @type {Node} */ s) => s !== click || left > 0)
    .map((/** @type {Node} */ s) => source.slice(s.start, s.end));

  if (trigger === "triggerEvent" && !rest.includes("triggerEvent")) rest.push("triggerEvent");

  edits.replace(
    helpers,
    `import { ${rest.join(", ")} } from ${source[helpers.source.start]}@ember/test-helpers${source[helpers.source.start]};`,
  );

  return edits.apply();
}

/**
 * @param {import('#project.js').Project} project
 */
export function updateOptionClicks(project) {
  let classes = optionClasses(project);

  for (let file of project.files(["tests/**/*.{js,ts,gjs,gts}"])) {
    let output = withOptionClicks(project.read(file), file, classes);

    if (output) project.write(file, output);
  }
}
