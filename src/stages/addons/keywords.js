import { dirname, relative } from "node:path";

import { toTree } from "ember-estree";

import { parseProgram, SKIP, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { editPackageJson, removeDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";
import { atLeast } from "#version.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('#project.js').Project} Project */

const SOURCES = ["{app,addon,addon-test-support,tests,src}/**/*.{js,ts,gjs,gts,hbs}"];

/**
 * An addon whose helpers ember-source 7.1 builds in as keywords of strict-mode templates.
 * The keywords check their argument count, so a call must fit it.
 *
 * @typedef {object} KeywordAddon
 * @property {string} name
 * @property {Map<string, { keyword: string, min: number, max: number }>} keywords by the helper's module name
 * @property {Map<string, string>} named the named exports of the package's main entry, to the module name
 * @property {RegExp} loose a loose-mode template call, which resolves the helper by name through the addon's app tree
 * @property {string} keywordNames for the progress note
 * @property {string} link
 * @property {Map<string, Replacement>} [replacements] by the helper's module name: where a helper that is no keyword goes
 */

/**
 * @typedef {object} Replacement
 * @property {string} [module] a package that exports the same function, such as `@ember/utils`
 * @property {string} [exported] its name there
 * @property {string} [file] the app module that holds the helper
 * @property {string} [source] the source of that module
 */

/**
 * From ember-truth-helpers 5 (MIT): `xor` counts truth like the templates do, with `isTruthy` and empty arrays as false.
 */
const XOR = `import { isArray } from '@ember/array';

function truthConvert(value) {
  if (typeof value === 'object' && value && 'isTruthy' in value && typeof value.isTruthy === 'boolean') {
    return value.isTruthy;
  }

  return isArray(value) ? value.length !== 0 : Boolean(value);
}

export default function xor(left, right) {
  return truthConvert(left) !== truthConvert(right);
}
`;

/**
 * From ember-truth-helpers 5 (MIT): `is-array` is true when each argument is an array.
 */
const IS_ARRAY = `import { isArray as isEmberArray } from '@ember/array';

export default function isArray(...values) {
  return values.every(isEmberArray);
}
`;

/** @type {KeywordAddon} */
export const TRUTH_HELPERS = {
  name: "ember-truth-helpers",
  /** RFCs 560, 561 and 562 */
  keywords: new Map([
    ["and", { keyword: "and", min: 2, max: Infinity }],
    ["or", { keyword: "or", min: 2, max: Infinity }],
    ["not", { keyword: "not", min: 1, max: 1 }],
    ["eq", { keyword: "eq", min: 2, max: 2 }],
    ["not-eq", { keyword: "neq", min: 2, max: 2 }],
    ["gt", { keyword: "gt", min: 2, max: 2 }],
    ["gte", { keyword: "gte", min: 2, max: 2 }],
    ["lt", { keyword: "lt", min: 2, max: 2 }],
    ["lte", { keyword: "lte", min: 2, max: 2 }],
  ]),
  named: new Map([
    ["and", "and"],
    ["or", "or"],
    ["not", "not"],
    ["eq", "eq"],
    ["notEq", "not-eq"],
    ["xor", "xor"],
    ["isArray", "is-array"],
    ["isEmpty", "is-empty"],
    ["isEqual", "is-equal"],
    ["gt", "gt"],
    ["gte", "gte"],
    ["lt", "lt"],
    ["lte", "lte"],
  ]),
  loose: /[({]\s*(and|or|not|eq|not-eq|gt|gte|lt|lte|xor|is-array|is-empty|is-equal)[\s)}]/,
  keywordNames: "and, or, not, eq, neq, gt, gte, lt and lte",
  link: "https://rfcs.emberjs.com/id/0562-add-logical-operators/",
  replacements: new Map([
    ["is-empty", { module: "@ember/utils", exported: "isEmpty" }],
    ["is-equal", { module: "@ember/utils", exported: "isEqual" }],
    ["xor", { file: "app/helpers/xor.js", source: XOR }],
    ["is-array", { file: "app/helpers/is-array.js", source: IS_ARRAY }],
  ]),
};

/** @type {KeywordAddon} */
export const ELEMENT_HELPER = {
  name: "ember-element-helper",
  /** RFC 389 */
  keywords: new Map([["element", { keyword: "element", min: 1, max: 1 }]]),
  named: new Map([["element", "element"]]),
  loose: /[({]\s*element[\s)}]/,
  keywordNames: "element",
  link: "https://rfcs.emberjs.com/id/0389-dynamic-tag-names/",
};

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
 * @param {KeywordAddon} addon
 * @param {Node} specifier
 * @param {string} from
 * @returns {string | undefined} the addon's module name of the imported helper
 */
function helperOf(addon, specifier, from) {
  let helpers = `${addon.name}/helpers/`;

  if (from === addon.name && specifier.type === "ImportSpecifier") {
    let imported = specifier.imported.name ?? specifier.imported.value;

    return addon.named.get(imported);
  }

  if (from.startsWith(helpers) && specifier.type === "ImportDefaultSpecifier") {
    return from.slice(helpers.length).replace(/\.js$/, "");
  }
}

/**
 * Replaces the imports of the addon's helpers with the keywords of ember-source 7.1.
 * A helper keeps its import when the file uses it in a way that the keyword does not take:
 * in JavaScript, with named arguments, with another argument count, or under a block param of the same name.
 *
 * @param {string} source a .gjs or .gts file
 * @param {string} file
 * @param {KeywordAddon} [addon]
 * @returns {string | undefined} the new source, or undefined when nothing changes
 */
export function useKeywords(source, file, addon = TRUTH_HELPERS) {
  let program = parseProgram(source, file);

  if (!program) return;

  /** @type {Map<string, { helper: string, specifier: Node, declaration: Node }>} */
  let imported = new Map();

  for (let node of /** @type {Node[]} */ (program.body)) {
    if (node.type !== "ImportDeclaration" || typeof node.source.value !== "string") continue;
    if (node.importKind === "type") continue;

    for (let specifier of node.specifiers) {
      let helper = helperOf(addon, specifier, node.source.value);

      if (helper && addon.keywords.has(helper)) {
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

    let rule = /** @type {{ min: number, max: number }} */ (addon.keywords.get(entry.helper));
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
    let { keyword } = /** @type {{ keyword: string }} */ (addon.keywords.get(helper));
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
 * @param {KeywordAddon} addon
 * @param {string} file
 * @param {string} source
 * @returns {boolean} the file has a loose-mode template that can call a helper of the addon by name
 */
function hasLooseUse(addon, file, source) {
  let template = file.endsWith(".hbs") || /\bhbs`|precompileTemplate\(/.test(source);

  return template && addon.loose.test(source);
}

/**
 * @param {string} from a module of the app, such as `app/components/x.gjs`
 * @param {string} file such as `app/helpers/xor.js`
 * @returns {string} the relative import, such as `../helpers/xor`
 */
function relativeImport(from, file) {
  let path = relative(dirname(from), file).split("\\").join("/").replace(/\.js$/, "");

  return path.startsWith(".") ? path : `./${path}`;
}

/**
 * Points the imports of the addon's helpers that are no keywords at their replacements.
 *
 * @param {string} source
 * @param {string} file
 * @param {KeywordAddon} addon
 * @param {(file: string, source: string) => boolean} canWrite the app has no other module at the path
 * @returns {{ output: string, files: Map<string, string> } | undefined} the module, and the helper modules that it needs
 */
export function useReplacements(source, file, addon, canWrite) {
  let replacements = addon.replacements;
  let program = replacements && parseProgram(source, file);

  if (!program || !replacements) return;

  let edits = new Edits(source);
  /** @type {Map<string, string>} */
  let files = new Map();

  for (let node of /** @type {Node[]} */ (program.body)) {
    if (node.type !== "ImportDeclaration" || typeof node.source.value !== "string") continue;
    if (node.importKind === "type") continue;

    /** @type {string[]} */
    let lines = [];
    /** @type {Node[]} */
    let moved = [];

    for (let specifier of node.specifiers) {
      let helper = helperOf(addon, specifier, node.source.value);
      let replacement = helper ? replacements.get(helper) : undefined;

      if (!replacement) continue;

      let local = specifier.local.name;

      if (replacement.module && replacement.exported) {
        let named = local === replacement.exported ? local : `${replacement.exported} as ${local}`;

        lines.push(`import { ${named} } from '${replacement.module}';`);
      } else if (
        replacement.file &&
        replacement.source &&
        canWrite(replacement.file, replacement.source)
      ) {
        lines.push(`import ${local} from '${relativeImport(file, replacement.file)}';`);
        files.set(replacement.file, replacement.source);
      } else {
        continue;
      }

      moved.push(specifier);
    }

    if (moved.length === 0) continue;

    let left = node.specifiers.filter(
      (/** @type {Node} */ specifier) => !moved.includes(specifier),
    );

    if (left.length > 0) {
      let names = left.map((/** @type {Node} */ s) => source.slice(s.start, s.end)).join(", ");
      let from = source.slice(node.source.start, node.source.end);

      lines.unshift(`import { ${names} } from ${from};`);
    }

    edits.replace(node, lines.join("\n"));
  }

  return edits.size > 0 ? { output: edits.apply(), files } : undefined;
}

/**
 * @param {KeywordAddon} addon
 * @param {Project} project
 */
function plan(addon, project) {
  /** @type {Map<string, string>} */
  let rewrites = new Map();
  /** @type {string[]} */
  let users = [];

  for (let file of project.files(SOURCES)) {
    let source = project.read(file);

    if (/\.g[jt]s$/.test(file) && source.includes(addon.name)) {
      let output = useKeywords(source, file, addon);

      if (output) {
        rewrites.set(file, output);
        source = output;
      }

      let replaced = useReplacements(
        source,
        file,
        addon,
        (path, content) =>
          rewrites.get(path) === content || !project.has(path) || project.read(path) === content,
      );

      if (replaced) {
        rewrites.set(file, replaced.output);
        source = replaced.output;

        for (let [path, content] of replaced.files) rewrites.set(path, content);
      }
    }

    if (source.includes(addon.name) || hasLooseUse(addon, file, source)) users.push(file);
  }

  return { rewrites, users };
}

/**
 * The stage runs after template-tag, when the templates are strict mode.
 *
 * @param {KeywordAddon} addon
 * @returns {import('#types.js').Stage}
 */
function keywordStage(addon) {
  return {
    name: addon.name,
    label: `Use the keywords of ember-source 7.1 in place of ${addon.name}`,

    /**
     * An app can import the addon without declaring it, when another addon brought it in.
     */
    detect(project) {
      if (!atLeast(project.dependency("ember-source"), 7, 1)) return false;

      let { rewrites, users } = plan(addon, project);

      return rewrites.size > 0 || (Boolean(project.dependency(addon.name)) && users.length === 0);
    },

    async check() {
      return { blockers: [], todo: [] };
    },

    async run(project) {
      let { rewrites, users } = plan(addon, project);

      let helperFiles = Array.from(addon.replacements?.values() ?? [])
        .map((replacement) => replacement.file)
        .filter((file) => file !== undefined && rewrites.has(file) && !project.has(file));

      for (let [file, output] of rewrites) project.write(file, output);

      if (helperFiles.length > 0) {
        recordProgress(project, {
          id: `${addon.name}: helpers`,
          status: "moved into the app",
          note: `The app uses helpers of ${addon.name} that are no keywords. Their code is in ${helperFiles.join(", ")} now.`,
        });
      }

      if (users.length === 0) {
        if (project.dependency(addon.name)) {
          editPackageJson(project, (pkg) => removeDependency(pkg, addon.name));
        }

        return [];
      }

      recordProgress(project, {
        id: addon.name,
        status: "kept",
        note:
          `These files still use ${addon.name}: ${users.join(", ")}. ` +
          `In strict-mode templates, use the keywords ${addon.keywordNames}. ` +
          `Remove ${addon.name} when no file uses it.`,
        links: [addon.link],
      });

      return [];
    },
  };
}

export const truthHelpers = keywordStage(TRUTH_HELPERS);
export const elementHelper = keywordStage(ELEMENT_HELPER);
