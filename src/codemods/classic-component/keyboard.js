import { parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { importMap, updateImports } from "#codemods/imports.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * The mixins of `ember-keyboard`, and the value of `keyboardActivated` that each one starts with.
 * The `on-key` helper registers when it renders, so a mixin that activates on insert starts active.
 */
const MIXINS = new Map([
  ["EKMixin", false],
  ["EKOnInitMixin", true],
  ["EKOnInsertMixin", true],
]);

/**
 * The functions of `ember-keyboard` that name a listener, and the event of each one.
 */
const LISTENERS = new Map([
  ["keyDown", "keydown"],
  ["keyUp", "keyup"],
  ["keyPress", "keypress"],
]);

/**
 * Removes the mixins of `ember-keyboard` from a classic component.
 * Each `on(keyDown('Escape'), fn)` becomes `on('keydown:Escape', fn)`, the listener name that `keyDown` returns,
 * so that the conversion can call the `on-key` helper from the template.
 *
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
export function rewriteKeyboard(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let imports = importMap(program);
  /** @type {Map<string, string>} */
  let locals = new Map();

  for (let [local, value] of imports) {
    if (value.module === "ember-keyboard") locals.set(local, value.imported);
  }

  if (locals.size === 0) return source;

  let edits = new Edits(source);

  walk(program, (node) => {
    if (node.type !== "CallExpression") return;

    let callee = node.callee?.type === "Identifier" ? locals.get(node.callee.name) : undefined;
    let first = node.arguments[0];

    if (callee === undefined && node.callee?.property?.name === "extend") {
      removeMixins(source, node, locals, edits);
    } else if (
      node.callee?.type === "Identifier" &&
      imports.get(node.callee.name)?.module === "@ember/object/evented" &&
      first?.type === "CallExpression" &&
      first.callee?.type === "Identifier"
    ) {
      let event = LISTENERS.get(locals.get(first.callee.name) ?? "");
      let combo = first.arguments[0];

      if (!event || first.arguments.length !== 1) return;
      if (combo?.type !== "Literal" || typeof combo.value !== "string") return;
      if (/['\\]/.test(combo.value)) return;

      edits.replace(first, `'${event}:${combo.value}'`);
    }
  });

  if (edits.size === 0) return source;

  return updateImports(edits.apply(), file, { prune: ["ember-keyboard"], add: new Map() });
}

/**
 * @param {string} source
 * @param {Node} call `Component.extend(...)`
 * @param {Map<string, string>} locals
 * @param {Edits} edits
 */
function removeMixins(source, call, locals, edits) {
  let args = call.arguments;
  let body = args.find((/** @type {Node} */ arg) => arg.type === "ObjectExpression");
  let mixins = args.filter(
    (/** @type {Node} */ arg) =>
      arg.type === "Identifier" && MIXINS.has(locals.get(arg.name) ?? ""),
  );

  if (!body || mixins.length !== 1) return;

  let mixin = mixins[0];
  let next = args[args.indexOf(mixin) + 1];

  if (!next) return;

  edits.replace({ start: mixin.start, end: next.start }, "");

  let declared = body.properties.some(
    (/** @type {Node} */ property) =>
      property.key?.name === "keyboardActivated" || property.key?.value === "keyboardActivated",
  );

  if (declared) return;

  let property = `keyboardActivated: ${MIXINS.get(locals.get(mixin.name) ?? "")}`;
  let first = body.properties[0];

  if (first) {
    let lineStart = source.lastIndexOf("\n", first.start - 1) + 1;
    let indent = source.slice(lineStart, first.start);

    edits.insert(first.start, `${property},\n${indent}`);
  } else {
    edits.insert(body.start + 1, `\n  ${property},\n`);
  }
}
