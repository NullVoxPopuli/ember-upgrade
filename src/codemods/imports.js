import { parseProgram, SKIP, walk } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * @param {Node} program
 * @returns {Map<string, { module: string, imported: string }>} each imported local name, and where it comes from
 */
export function importMap(program) {
  /** @type {Map<string, { module: string, imported: string }>} */
  let map = new Map();

  for (let node of program.body) {
    if (node.type !== "ImportDeclaration") continue;

    for (let specifier of node.specifiers ?? []) {
      let imported =
        specifier.type === "ImportDefaultSpecifier"
          ? "default"
          : specifier.type === "ImportNamespaceSpecifier"
            ? "*"
            : (specifier.imported?.name ?? specifier.imported?.value);

      map.set(specifier.local.name, { module: node.source.value, imported });
    }
  }

  return map;
}

/**
 * @param {Node} program
 * @returns {Map<string, number>} how many times the module uses each name, outside of its imports
 */
function references(program) {
  /** @type {Map<string, number>} */
  let counts = new Map();

  walk(program, (node, parent) => {
    if (node.type === "ImportDeclaration") return SKIP;

    if (node.type !== "Identifier") return;

    let isKey =
      (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) ||
      ((parent?.type === "Property" ||
        parent?.type === "MethodDefinition" ||
        parent?.type === "PropertyDefinition") &&
        parent.key === node &&
        !parent.computed &&
        !(parent.type === "Property" && parent.shorthand));

    if (isKey) return;

    counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
  });

  return counts;
}

/**
 * Removes the names that a module no longer uses from the imports of the given modules,
 * and adds the named imports that it needs.
 *
 * @param {string} source
 * @param {string} file
 * @param {{ prune: string[], add: Map<string, Set<string>> }} changes `add` maps a module to its named imports, or `default:Name` for a default import
 * @returns {string}
 */
export function updateImports(source, file, changes) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let counts = references(program);
  let edits = new Edits(source);
  let imports = program.body.filter(
    (/** @type {Node} */ node) => node.type === "ImportDeclaration",
  );
  /** @type {Map<string, Set<string>>} */
  let missing = new Map();
  /** @type {Set<Node>} */
  let removed = new Set();

  for (let [module, names] of changes.add) {
    let have = new Set(
      Array.from(importMap(program))
        .filter(([, value]) => value.module === module)
        .map(([local, value]) => (value.imported === "default" ? `default:${local}` : local)),
    );
    let need = new Set(Array.from(names).filter((name) => !have.has(name)));

    if (need.size > 0) missing.set(module, need);
  }

  for (let node of imports) {
    let module = node.source.value;
    let prune = changes.prune.includes(module);
    let kept = (node.specifiers ?? []).filter(
      (/** @type {Node} */ specifier) => !prune || (counts.get(specifier.local.name) ?? 0) > 0,
    );
    let added = missing.get(module);

    if (kept.length === node.specifiers.length && !added) continue;

    if (kept.length === 0 && !added) {
      edits.removeLine(node);
      removed.add(node);
      continue;
    }

    missing.delete(module);

    let defaultName = kept.find(
      (/** @type {Node} */ specifier) => specifier.type === "ImportDefaultSpecifier",
    )?.local.name;
    let named = kept
      .filter((/** @type {Node} */ specifier) => specifier.type === "ImportSpecifier")
      .map((/** @type {Node} */ specifier) => source.slice(specifier.start, specifier.end));

    for (let name of added ?? []) {
      if (name.startsWith("default:")) defaultName ??= name.slice("default:".length);
      else named.push(name);
    }

    let quote = source.charAt(node.source.start);

    edits.replace(node, importText(defaultName, named, `${quote}${module}${quote}`));
  }

  if (missing.size > 0) {
    let last = imports.filter((/** @type {Node} */ node) => !removed.has(node)).pop();
    let lines = Array.from(missing).map(([module, names]) => {
      let list = Array.from(names);
      let defaultName = list.find((name) => name.startsWith("default:"))?.slice(8);

      return importText(
        defaultName,
        list.filter((name) => !name.startsWith("default:")),
        `'${module}'`,
      );
    });

    if (last) edits.insert(last.end, `\n${lines.join("\n")}`);
    else edits.insert(imports[0]?.start ?? 0, `${lines.join("\n")}\n`);
  }

  return edits.size > 0 ? edits.apply() : source;
}

/**
 * @param {string | undefined} defaultName
 * @param {string[]} named
 * @param {string} module the quoted module
 * @returns {string}
 */
function importText(defaultName, named, module) {
  let parts = [];

  if (defaultName) parts.push(defaultName);
  if (named.length > 0) parts.push(`{ ${named.join(", ")} }`);

  return `import ${parts.join(", ")} from ${module};`;
}
