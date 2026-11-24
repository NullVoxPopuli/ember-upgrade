import { toTree } from "ember-estree";

import { parseProgram, SKIP, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { editPackageJson, removeDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";
import { atLeast } from "#version.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('#project.js').Project} Project */

const ADDON = "ember-truth-helpers";

const SOURCES = ["{app,addon,addon-test-support,tests,src}/**/*.{js,ts,gjs,gts,hbs}"];

/**
 * The helpers that ember-source 7.1 builds in as keywords of strict-mode templates
 * (RFCs 560, 561 and 562), by their name in ember-truth-helpers.
 * The keywords check their argument count, so a call must fit it.
 *
 * @type {Map<string, { keyword: string, min: number, max: number }>}
 */
const KEYWORDS = new Map([
  ["and", { keyword: "and", min: 2, max: Infinity }],
  ["or", { keyword: "or", min: 2, max: Infinity }],
  ["not", { keyword: "not", min: 1, max: 1 }],
  ["eq", { keyword: "eq", min: 2, max: 2 }],
  ["not-eq", { keyword: "neq", min: 2, max: 2 }],
  ["gt", { keyword: "gt", min: 2, max: 2 }],
  ["gte", { keyword: "gte", min: 2, max: 2 }],
  ["lt", { keyword: "lt", min: 2, max: 2 }],
  ["lte", { keyword: "lte", min: 2, max: 2 }],
]);

/**
 * The named exports of the package's main entry.
 *
 * @type {Map<string, string>}
 */
const NAMED = new Map([
  ["and", "and"],
  ["or", "or"],
  ["not", "not"],
  ["eq", "eq"],
  ["notEq", "not-eq"],
  ["gt", "gt"],
  ["gte", "gte"],
  ["lt", "lt"],
  ["lte", "lte"],
]);

const HELPER_PATH = `${ADDON}/helpers/`;

/**
 * A loose-mode template resolves a helper by its name, through the addon's app tree.
 */
const LOOSE_USE =
  /[({]\s*(and|or|not|eq|not-eq|gt|gte|lt|lte|xor|is-array|is-empty|is-equal)[\s)}]/;

/**
 * @param {unknown} node
 * @param {(node: Node, parent: Node | undefined) => void} visit
 * @param {Node} [parent]
 */
function walkAll(node, visit, parent) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let child of node) walkAll(child, visit, parent);
    return;
  }

  let astNode = /** @type {Node} */ (node);

  if (typeof astNode.type === "string") visit(astNode, parent);

  let next = typeof astNode.type === "string" ? astNode : parent;

  for (let key in astNode) {
    if (key === "loc" || key === "range" || key === "parent" || key === "tokens") continue;

    walkAll(astNode[key], visit, next);
  }
}

/**
 * @param {Node} specifier
 * @param {string} from
 * @returns {string | undefined} the ember-truth-helpers name of the imported helper
 */
function helperOf(specifier, from) {
  if (from === ADDON && specifier.type === "ImportSpecifier") {
    let imported = specifier.imported.name ?? specifier.imported.value;

    return NAMED.get(imported);
  }

  if (from.startsWith(HELPER_PATH) && specifier.type === "ImportDefaultSpecifier") {
    return from.slice(HELPER_PATH.length).replace(/\.js$/, "");
  }
}

/**
 * Replaces the imports of ember-truth-helpers with the keywords of ember-source 7.1.
 * A helper keeps its import when the file uses it in a way that the keyword does not take:
 * in JavaScript, with named arguments, with another argument count, or under a block param of the same name.
 *
 * @param {string} source a .gjs or .gts file
 * @param {string} file
 * @returns {string | undefined} the new source, or undefined when nothing changes
 */
export function useKeywords(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  /** @type {Map<string, { helper: string, specifier: Node, declaration: Node }>} */
  let imported = new Map();

  for (let node of /** @type {Node[]} */ (program.body)) {
    if (node.type !== "ImportDeclaration" || typeof node.source.value !== "string") continue;
    if (node.importKind === "type") continue;

    for (let specifier of node.specifiers) {
      let helper = helperOf(specifier, node.source.value);

      if (helper && KEYWORDS.has(helper)) {
        imported.set(specifier.local.name, { helper, specifier, declaration: node });
      }
    }
  }

  if (imported.size === 0) return;

  /** @type {Set<string>} */
  let jsNames = new Set();

  walk(program, (node) => {
    if (node.type === "ImportDeclaration") {
      for (let specifier of node.specifiers) {
        if (!imported.has(specifier.local.name)) jsNames.add(specifier.local.name);
      }

      return SKIP;
    }

    if (node.type === "Identifier") jsNames.add(node.name);
  });

  /** @type {Set<string>} */
  let blockParams = new Set();
  /** @type {Map<string, Node[]>} */
  let calls = new Map();
  /** @type {Set<string>} */
  let unfit = new Set();

  walkAll(toTree(source, { filePath: file }), (node, parent) => {
    if (node.type === "GlimmerBlockParam") blockParams.add(node.name);

    if (node.type !== "GlimmerPathExpression") return;

    let head = node.original.split(".")[0];
    let entry = imported.get(head);

    if (!entry) return;

    let rule = /** @type {{ min: number, max: number }} */ (KEYWORDS.get(entry.helper));
    let isCall =
      node.original === head &&
      (parent?.type === "GlimmerSubExpression" || parent?.type === "GlimmerMustacheStatement") &&
      parent.path === node &&
      (parent.hash?.pairs?.length ?? 0) === 0 &&
      parent.params.length >= rule.min &&
      parent.params.length <= rule.max;

    if (isCall) calls.set(head, (calls.get(head) ?? []).concat(node));
    else unfit.add(head);
  });

  let edits = new Edits(source);
  /** @type {Map<Node, Node[]>} */
  let removed = new Map();

  for (let [local, { helper, specifier, declaration }] of imported) {
    let { keyword } = /** @type {{ keyword: string }} */ (KEYWORDS.get(helper));
    let renamed = local !== keyword;

    if (
      unfit.has(local) ||
      jsNames.has(local) ||
      blockParams.has(local) ||
      blockParams.has(keyword)
    ) {
      continue;
    }

    /**
     * A JavaScript name in the module would take the place of the keyword.
     */
    if (renamed && jsNames.has(keyword)) continue;

    for (let call of calls.get(local) ?? []) {
      if (renamed) edits.replace(call, keyword);
    }

    removed.set(declaration, (removed.get(declaration) ?? []).concat(specifier));
  }

  for (let [declaration, specifiers] of removed) {
    let left = declaration.specifiers.filter(
      (/** @type {Node} */ specifier) => !specifiers.includes(specifier),
    );

    if (left.length === 0) {
      edits.removeLine(declaration);
      continue;
    }

    let names = left.map((/** @type {Node} */ s) => source.slice(s.start, s.end)).join(", ");
    let from = source.slice(declaration.source.start, declaration.source.end);
    let semicolon = source[declaration.end - 1] === ";" ? ";" : "";

    edits.replace(declaration, `import { ${names} } from ${from}${semicolon}`);
  }

  return edits.size > 0 ? edits.apply() : undefined;
}

/**
 * @param {string} file
 * @param {string} source
 * @returns {boolean} the file has a loose-mode template that can call a helper of the addon by name
 */
function hasLooseUse(file, source) {
  let template = file.endsWith(".hbs") || /\bhbs`|precompileTemplate\(/.test(source);

  return template && LOOSE_USE.test(source);
}

/**
 * @param {Project} project
 */
function plan(project) {
  /** @type {Map<string, string>} */
  let rewrites = new Map();
  /** @type {string[]} */
  let users = [];

  for (let file of project.files(SOURCES)) {
    let source = project.read(file);

    if (/\.g[jt]s$/.test(file) && source.includes(ADDON)) {
      let output = useKeywords(source, file);

      if (output) {
        rewrites.set(file, output);
        source = output;
      }
    }

    if (source.includes(ADDON) || hasLooseUse(file, source)) users.push(file);
  }

  return { rewrites, users };
}

/**
 * ember-source 7.1 has the comparison and logic helpers of ember-truth-helpers as keywords.
 * The stage runs after template-tag, when the templates are strict mode.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: ADDON,
  label: `Use the keywords of ember-source 7.1 in place of ${ADDON}`,

  detect(project) {
    if (!project.dependency(ADDON) || !atLeast(project.dependency("ember-source"), 7, 1)) {
      return false;
    }

    let { rewrites, users } = plan(project);

    return rewrites.size > 0 || users.length === 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let { rewrites, users } = plan(project);

    for (let [file, output] of rewrites) project.write(file, output);

    if (users.length === 0) {
      editPackageJson(project, (pkg) => removeDependency(pkg, ADDON));
      return [];
    }

    recordProgress(project, {
      id: ADDON,
      status: "kept",
      note:
        `These files still use ${ADDON}: ${users.join(", ")}. ` +
        "In strict-mode templates, use the keywords and, or, not, eq, neq, gt, gte, lt and lte. " +
        `Remove ${ADDON} when no file uses it.`,
      links: ["https://rfcs.emberjs.com/id/0562-add-logical-operators/"],
    });

    return [];
  },
};
