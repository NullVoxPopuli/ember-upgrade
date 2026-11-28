import { toTree } from "ember-estree";

import { Edits } from "#edits.js";
import { recordProgress } from "#progress.js";
import { templateNames } from "./names.js";

/** @typedef {import('#ast.js').Node} Node */

const TEMPLATES = ["app/**/*.hbs"];
const OPEN = "<template>";
const OPENING = /^\{\{~?#component[\s\S]*?~?\}\}/;
const CLOSING = /\{\{~?\/component~?\}\}$/;
const VALUE = /\{\{~?#?component\s+[^"'\s(]/;
const CONCAT = /\{\{~?#?component\s+\(concat\s/;

/**
 * A key of a `hash` call, which is also the part of a component name that the `concat` call fills in.
 */
const KEY = /^[A-Za-z_][\w-]*$/;

/**
 * The block param of the component that a `concat` name selects.
 */
const SELECTED = "SelectedComponent";

/**
 * @param {unknown} node
 * @param {(node: Node) => void} visit
 */
function walkAll(node, visit) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let child of node) walkAll(child, visit);
    return;
  }

  let astNode = /** @type {Node} */ (node);

  if (typeof astNode.type === "string") visit(astNode);

  for (let key in astNode) {
    if (key === "loc" || key === "range" || key === "parent" || key === "tokens") continue;

    walkAll(astNode[key], visit);
  }
}

/**
 * @param {string} source
 * @param {Node} pair a named argument of the `component` call
 * @returns {string} the same argument of an angle bracket invocation
 */
function argument(source, pair) {
  let text = source.slice(pair.value.start, pair.value.end);

  switch (pair.value.type) {
    case "GlimmerStringLiteral":
      return `@${pair.key}=${text}`;
    case "GlimmerSubExpression":
      return `@${pair.key}={{${text.slice(1, -1)}}}`;
    default:
      return `@${pair.key}={{${text}}}`;
  }
}

/**
 * @param {Node} node a `component` mustache or block
 * @returns {boolean} the first argument is a value, which an angle bracket invocation can take
 */
function convertible(node) {
  return (
    node.path?.original === "component" &&
    node.params?.length === 1 &&
    node.params[0].type === "GlimmerPathExpression" &&
    !node.inverse
  );
}

/**
 * Turns `{{component <value> a=b}}` into `<value @a={{b}} />`, and the block form into an element.
 *
 * @param {string} template the source of an .hbs file
 * @returns {string} the new source, the same when the template has no such call
 */
export function angleBracketComponents(template) {
  let source = `${OPEN}${template}</template>`;
  /** @type {Node[]} */
  let calls = [];

  walkAll(toTree(source, { filePath: "template.gjs" }), (node) => {
    if (
      (node.type === "GlimmerMustacheStatement" || node.type === "GlimmerBlockStatement") &&
      convertible(node)
    ) {
      calls.push(node);
    }
  });

  if (calls.length === 0) return template;

  let edits = new Edits(source);

  for (let call of calls) {
    let element = asElement(source, call, source.slice(call.params[0].start, call.params[0].end));

    if (element) edits.replace(call, element);
  }

  let output = edits.apply();

  return output.slice(OPEN.length, output.length - "</template>".length);
}

/**
 * @param {string} source
 * @param {Node} call a `component` mustache or block
 * @param {string} tag the value that the element invokes
 * @returns {string | undefined} the angle bracket invocation, with the same arguments and block
 */
function asElement(source, call, tag) {
  let attributes = [tag]
    .concat((call.hash?.pairs ?? []).map((/** @type {Node} */ pair) => argument(source, pair)))
    .join(" ");

  if (call.type === "GlimmerMustacheStatement") return `<${attributes} />`;

  let text = source.slice(call.start, call.end);
  let opening = OPENING.exec(text)?.[0];
  let closing = CLOSING.exec(text)?.[0];

  if (!opening || !closing) return;

  let params = call.program?.blockParams ?? [];
  let block = params.length > 0 ? ` as |${params.join(" ")}|` : "";
  let body = text.slice(opening.length, text.length - closing.length);

  return `<${attributes}${block}>${body}</${tag}>`;
}

/**
 * @param {Node} node the first argument of a `component` call
 * @returns {{ prefix: string, suffix: string, key: Node } | undefined} for `(concat "a/" x "/b")`, where only `x` is not a string
 */
function concatName(node) {
  if (
    node?.type !== "GlimmerSubExpression" ||
    node.path.original !== "concat" ||
    node.hash?.pairs?.length
  ) {
    return;
  }

  let dynamic = node.params.filter(
    (/** @type {Node} */ param) => param.type !== "GlimmerStringLiteral",
  );

  if (dynamic.length !== 1) return;

  let index = node.params.indexOf(dynamic[0]);
  let join = (/** @type {Node[]} */ params) => params.map((param) => param.value).join("");

  return {
    prefix: join(node.params.slice(0, index)),
    suffix: join(node.params.slice(index + 1)),
    key: dynamic[0],
  };
}

/**
 * Turns `{{component (concat "a/" x "/b")}}` into a choice between the components whose names match,
 * which Embroider resolves at build time. A call that matches no component is removed,
 * because it threw each time that it rendered.
 *
 * @param {string} template the source of an .hbs file
 * @param {Set<string>} components the names that a template can call
 * @returns {{ output: string, removed: string[] }} removed has the name pattern of each removed call
 */
export function concatComponents(template, components) {
  let source = `${OPEN}${template}</template>`;
  let edits = new Edits(source);
  /** @type {string[]} */
  let removed = [];
  /**
   * The calls that this function changes. A call inside one of them stays, because its edit would overlap.
   *
   * @type {Node[]}
   */
  let handled = [];

  walkAll(toTree(source, { filePath: "template.gjs" }), (node) => {
    if (
      (node.type !== "GlimmerMustacheStatement" && node.type !== "GlimmerBlockStatement") ||
      node.path?.original !== "component" ||
      node.params?.length !== 1 ||
      node.inverse ||
      handled.some((call) => call.start <= node.start && node.end <= call.end)
    ) {
      return;
    }

    let name = concatName(node.params[0]);

    if (!name) return;

    /** @type {string[]} */
    let pairs = [];

    for (let component of Array.from(components).sort()) {
      if (!component.startsWith(name.prefix) || !component.endsWith(name.suffix)) continue;

      let key = component.slice(name.prefix.length, component.length - name.suffix.length);

      if (KEY.test(key)) pairs.push(`${key}=(component "${component}")`);
    }

    if (pairs.length === 0) {
      handled.push(node);
      edits.removeLine(node);
      removed.push(`${name.prefix}*${name.suffix}`);
      return;
    }

    let element = asElement(source, node, SELECTED);
    let key = source.slice(name.key.start, name.key.end);

    if (!element) return;

    handled.push(node);
    edits.replace(
      node,
      `{{#let (get (hash ${pairs.join(" ")}) ${key}) as |${SELECTED}|}}${element}{{/let}}`,
    );
  });

  let output = edits.apply();

  return { output: output.slice(OPEN.length, output.length - "</template>".length), removed };
}

/**
 * Embroider resolves components at build time, so it rejects `{{component <path>}}`,
 * even when the path is a block param: "Unsafe dynamic component".
 * An angle bracket invocation takes the same value, and Embroider accepts it.
 * A name that `concat` builds becomes a choice between the components that it can name.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "dynamic-components",
  label: "Invoke components that are values with angle brackets",
  needsInstall: true,

  detect(project) {
    return project.files(TEMPLATES).some((file) => {
      let source = project.read(file);

      return (
        (VALUE.test(source) && angleBracketComponents(source) !== source) || CONCAT.test(source)
      );
    });
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    /** @type {string[]} */
    let changed = [];
    /** @type {string[]} */
    let removed = [];
    let components = templateNames(project)?.components;

    for (let file of project.files(TEMPLATES)) {
      let source = project.read(file);
      let output = VALUE.test(source) ? angleBracketComponents(source) : source;

      if (components && CONCAT.test(output)) {
        let result = concatComponents(output, components);

        output = result.output;

        for (let pattern of result.removed) removed.push(`${file} (${pattern})`);
      }

      if (output !== source) {
        project.write(file, output);
        changed.push(file);
      }
    }

    if (removed.length > 0) {
      recordProgress(project, {
        id: "dynamic-components: removed",
        status: "todo",
        note:
          `These \`{{component (concat ...)}}\` calls named no component of the app or its addons, so they were removed: ${removed.join(", ")}. ` +
          "Check that the app did not need them.",
        links: [
          "https://github.com/embroider-build/embroider/blob/main/docs/replacing-component-helper.md",
        ],
      });
    }

    if (changed.length === 0) return [];

    recordProgress(project, {
      id: "dynamic-components",
      status: "changed",
      note:
        `${changed.join(", ")} invoke components that are values with angle brackets now, such as \`<btn @value={{1}} />\`, ` +
        "not with `{{component btn value=1}}`, which Embroider cannot resolve at build time.",
      links: [
        "https://github.com/embroider-build/embroider/blob/main/docs/replacing-component-helper.md",
      ],
    });

    return [];
  },
};
