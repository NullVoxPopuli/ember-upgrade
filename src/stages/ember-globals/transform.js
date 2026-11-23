import { identifierName, parseProgram, SKIP, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { GLOBALS } from "./mappings.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('./mappings.js').ModuleExport} ModuleExport */
/** @typedef {import('#types.js').Finding} Finding */

/**
 * Names that are bindings or references.
 * Property keys are not, so `this.computed` does not block a `computed` import.
 *
 * @param {Node} program
 */
function boundNames(program) {
  /** @type {Set<string>} */
  let names = new Set();

  walk(program, (node, parent) => {
    if (node.type !== "Identifier" || !parent) return;

    let isKey =
      (parent.type === "MemberExpression" && parent.property === node && !parent.computed) ||
      (parent.type === "Property" &&
        parent.key === node &&
        !parent.computed &&
        !parent.shorthand) ||
      ((parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") &&
        parent.key === node &&
        !parent.computed);

    if (!isKey) names.add(node.name);
  });

  return names;
}

/**
 * @param {Node} node a MemberExpression
 * @returns {{ root: string, names: string[], nodes: Node[] } | undefined}
 *   for `Ember.computed.alias`: root "Ember", names ["computed", "alias"],
 *   and nodes [`Ember.computed`, `Ember.computed.alias`]
 */
function memberChain(node) {
  /** @type {Node[]} */
  let nodes = [];
  let current = node;

  while (
    current.type === "MemberExpression" &&
    !current.computed &&
    current.property.type === "Identifier"
  ) {
    nodes.push(current);
    current = current.object;
  }

  let root = identifierName(current);

  if (!root || nodes.length === 0) return;

  nodes.reverse();

  return { root, names: nodes.map((n) => n.property.name), nodes };
}

/**
 * @param {string} path for example "Ember.inject"
 * @returns {boolean} true when RFC 176 maps members of the path, but not the path itself
 */
function isNamespace(path) {
  let prefix = `${path}.`;

  for (let global of GLOBALS.keys()) {
    if (global.startsWith(prefix)) return true;
  }

  return false;
}

/**
 * The imports to add, per module.
 */
class Imports {
  /** @type {Map<string, { defaults: string[], named: Map<string, string> }>} local name to export name */
  modules = new Map();

  /**
   * @param {Node} program
   * @param {Set<string>} names taken names, which grows as names are given out
   */
  constructor(program, names) {
    this.names = names;

    /** @type {Map<string, string>} "module\0export" to the local name of an existing import */
    this.existing = new Map();

    for (let node of program.body) {
      if (node.type !== "ImportDeclaration" || node.importKind === "type") continue;

      for (let specifier of node.specifiers) {
        if (specifier.importKind === "type") continue;

        let exportName =
          specifier.type === "ImportDefaultSpecifier"
            ? "default"
            : specifier.type === "ImportSpecifier"
              ? (specifier.imported.name ?? specifier.imported.value)
              : undefined;

        if (exportName) {
          this.existing.set(`${node.source.value}\0${exportName}`, specifier.local.name);
        }
      }
    }
  }

  /**
   * @param {ModuleExport} entry
   * @returns {string | undefined}
   */
  #find(entry) {
    let existing = this.existing.get(`${entry.module}\0${entry.export}`);

    if (existing) return existing;

    let wanted = this.modules.get(entry.module);

    if (!wanted) return;
    if (entry.export === "default") return wanted.defaults[0];

    for (let [local, exportName] of wanted.named) {
      if (exportName === entry.export) return local;
    }
  }

  /**
   * @param {ModuleExport} entry
   * @param {string} [local] the name the code already uses, from a destructure
   * @returns {string} the local name to use in the code
   */
  request(entry, local) {
    let found = this.#find(entry);

    if (found && (!local || found === local)) return found;

    if (!local) {
      local = entry.localName;

      if (this.names.has(local)) {
        let base = `Ember${local[0].toUpperCase()}${local.slice(1)}`;

        local = base;

        for (let i = 2; this.names.has(local); i++) local = `${base}${i}`;
      }
    }

    this.names.add(local);

    let wanted = this.modules.get(entry.module);

    if (!wanted) {
      wanted = { defaults: [], named: new Map() };
      this.modules.set(entry.module, wanted);
    }

    if (entry.export === "default") {
      wanted.defaults.push(local);
    } else {
      wanted.named.set(local, entry.export);
    }

    return local;
  }

  /**
   * @param {string} quote
   * @param {string} semi
   * @returns {string[]}
   */
  lines(quote, semi) {
    /** @type {string[]} */
    let lines = [];

    for (let [module, { defaults, named }] of this.modules) {
      /** @type {string[]} */
      let specifiers = [];

      for (let [local, exportName] of named) {
        specifiers.push(local === exportName ? local : `${exportName} as ${local}`);
      }

      let from = `from ${quote}${module}${quote}${semi}`;
      let first = defaults[0];
      let braces = specifiers.length > 0 ? `{ ${specifiers.join(", ")} }` : "";

      if (first && braces) lines.push(`import ${first}, ${braces} ${from}`);
      else if (first) lines.push(`import ${first} ${from}`);
      else lines.push(`import ${braces} ${from}`);

      for (let i = 1; i < defaults.length; i++) {
        lines.push(`import ${defaults[i]} ${from}`);
      }
    }

    return lines;
  }
}

/**
 * One binding from a destructure of `Ember`.
 *
 * @typedef {object} Leaf
 * @property {string} path for example "Ember.inject.service"
 * @property {string} local the name the code uses
 * @property {Node} node the binding Identifier
 * @property {ModuleExport} [entry] the import, when RFC 176 maps the path
 * @property {boolean} [namespace] true for `const { inject } = Ember`, where the code then reads `inject.service`
 */

/**
 * @param {Node} value a property value in an ObjectPattern
 * @param {string[]} path
 * @param {number} depth
 * @param {Leaf[]} leaves
 * @returns {boolean} false when the shape is not supported, for example a default value
 */
function collectLeaves(value, path, depth, leaves) {
  if (value.type === "Identifier") {
    let global = path.join(".");
    let entry = GLOBALS.get(global);

    leaves.push({
      path: global,
      local: value.name,
      node: value,
      entry,
      namespace: !entry && depth === 1 && isNamespace(global),
    });

    return true;
  }

  if (value.type !== "ObjectPattern") return false;

  for (let property of value.properties) {
    let key = property.type === "Property" && !property.computed && identifierName(property.key);

    if (!key || !collectLeaves(property.value, path.concat(key), depth + 1, leaves)) return false;
  }

  return true;
}

/**
 * A top-level property of a destructure of `Ember`.
 * It moves to imports as a whole, or stays as a whole.
 *
 * @typedef {object} Destructured
 * @property {Node} property
 * @property {Leaf[]} leaves
 * @property {boolean} supported
 */

/**
 * Replaces `Ember.*` globals with imports from the RFC 176 modules.
 *
 * Handles member chains (`Ember.computed.alias`),
 * destructures (`const { computed, inject: { service } } = Ember`),
 * and namespaces from destructures (`const { inject } = Ember; inject.service()`).
 * The `ember` import stays when a use has no module.
 *
 * @param {string} source
 * @param {string} filePath
 * @returns {{ code: string, todo: Finding[] }}
 */
export function transform(source, filePath) {
  /** @type {Finding[]} */
  let todo = [];
  let program = parseProgram(source, filePath);

  if (!program) {
    return { code: source, todo: [{ title: "Does not parse", where: [filePath] }] };
  }

  let emberImport = program.body.find(
    (/** @type {Node} */ node) =>
      node.type === "ImportDeclaration" &&
      node.source.value === "ember" &&
      node.importKind !== "type",
  );
  let ember = emberImport?.specifiers.find(
    (/** @type {Node} */ s) => s.type === "ImportDefaultSpecifier",
  )?.local.name;

  if (!emberImport || !ember) return { code: source, todo };

  let edits = new Edits(source);
  let imports = new Imports(program, boundNames(program));
  let remaining = 0;

  /** @type {Map<string, string>} local name to the global path it stands for */
  let roots = new Map([[ember, "Ember"]]);
  /** @type {Set<string>} namespace locals with a use that has no module */
  let unresolvedRoots = new Set();
  /** @type {Map<Node, { declaration: Node, properties: Destructured[] }>} */
  let destructures = new Map();

  /**
   * @param {Node} node
   */
  function lineOf(node) {
    return `${filePath}:${source.slice(0, node.start).split("\n").length}`;
  }

  /**
   * @param {string} what
   * @param {Node} node
   */
  function keep(what, node) {
    todo.push({
      title: `${what} has no module`,
      where: [lineOf(node)],
      action: "Replace it by hand, then remove the `ember` import.",
    });
  }

  walk(program, (node, parent) => {
    if (
      node.type !== "VariableDeclarator" ||
      identifierName(node.init) !== ember ||
      node.id.type !== "ObjectPattern" ||
      parent?.type !== "VariableDeclaration"
    ) {
      return;
    }

    /** @type {Destructured[]} */
    let properties = [];

    for (let property of node.id.properties) {
      /** @type {Leaf[]} */
      let leaves = [];
      let key = property.type === "Property" && !property.computed && identifierName(property.key);
      let supported =
        Boolean(key) && collectLeaves(property.value, ["Ember", String(key)], 1, leaves);

      properties.push({ property, leaves, supported });

      if (!supported) continue;

      /**
       * Imports for destructured names come first,
       * so that `Ember.get` elsewhere in the file reuses the `get` that the code already has.
       */
      if (leaves.every((leaf) => leaf.entry)) {
        for (let leaf of leaves)
          imports.request(/** @type {ModuleExport} */ (leaf.entry), leaf.local);
      }

      for (let leaf of leaves) {
        if (leaf.namespace) roots.set(leaf.local, leaf.path);
      }
    }

    destructures.set(node, { declaration: parent, properties });

    return SKIP;
  });

  walk(program, (node) => {
    if (node === emberImport || destructures.has(node)) return SKIP;

    /**
     * `Ember.onerror` has no module and no replacement (deprecation id ember.deprecate-import-onerror-from-ember).
     * The browser's error event reaches the same errors, so a handler goes there.
     */
    let handler = node.type === "AssignmentExpression" ? node.right : undefined;

    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "MemberExpression" &&
      !node.left.computed &&
      identifierName(node.left.object) === ember &&
      node.left.property.name === "onerror" &&
      (handler.type === "FunctionExpression" || handler.type === "ArrowFunctionExpression") &&
      handler.params.length <= 1 &&
      (handler.params.length === 0 || handler.params[0].type === "Identifier")
    ) {
      let text = source.slice(handler.start, handler.end);
      let param = handler.params[0];

      if (param) {
        let pattern = param.name === "error" ? "{ error }" : `{ error: ${param.name} }`;

        text =
          text.slice(0, param.start - handler.start) +
          pattern +
          text.slice(param.end - handler.start);
      }

      edits.replace(node, `window.addEventListener("error", ${text})`);
      todo.push({
        title: "`Ember.onerror` is a listener of the window's error event now",
        where: [lineOf(node)],
        action:
          "Check that the handler still gets the errors that it needs, such as rejected promises.",
      });

      return SKIP;
    }

    if (node.type === "MemberExpression") {
      let chain = memberChain(node);
      let rootPath = chain && roots.get(chain.root);

      if (!chain || !rootPath) return;

      for (let i = chain.names.length - 1; i >= 0; i--) {
        let entry = GLOBALS.get(`${rootPath}.${chain.names.slice(0, i + 1).join(".")}`);

        if (entry) {
          edits.replace(chain.nodes[i], imports.request(entry));

          return SKIP;
        }
      }

      if (chain.root === ember) remaining++;
      else unresolvedRoots.add(chain.root);

      keep(`\`${rootPath}.${chain.names.join(".")}\``, node);

      return SKIP;
    }

    if (node.type === "TSQualifiedName") {
      let left = node;

      while (left.type === "TSQualifiedName") left = left.left;

      if (identifierName(left) === ember) {
        remaining++;
        keep(`The type \`${source.slice(node.start, node.end)}\``, node);

        return SKIP;
      }
    }

    let name = identifierName(node);

    if (name === ember) {
      remaining++;
      keep(`\`${ember}\` as a value`, node);
    } else if (name && roots.has(name)) {
      unresolvedRoots.add(name);
      keep(`\`${roots.get(name)}\` as a value`, node);
    }
  });

  /** @type {Set<Node>} */
  let removed = new Set();

  for (let [declarator, { properties }] of destructures) {
    /** @type {Node[]} */
    let kept = [];

    for (let { property, leaves, supported } of properties) {
      let moves =
        supported &&
        leaves.every((leaf) => leaf.entry || (leaf.namespace && !unresolvedRoots.has(leaf.local)));

      if (moves) continue;

      kept.push(property);

      for (let leaf of leaves) {
        if (!leaf.entry && !leaf.namespace) keep(`\`${leaf.path}\``, leaf.node);
      }
    }

    if (kept.length === 0) {
      removed.add(declarator);
    } else {
      remaining++;

      if (kept.length < properties.length) {
        let text = kept.map((p) => source.slice(p.start, p.end)).join(", ");

        edits.replace(declarator.id, `{ ${text} }`);
      }
    }
  }

  /** @type {Set<Node>} */
  let declarations = new Set();

  for (let { declaration } of destructures.values()) declarations.add(declaration);

  for (let declaration of declarations) {
    let all = declaration.declarations;

    if (all.every((/** @type {Node} */ d) => removed.has(d))) {
      edits.removeLine(declaration);
      continue;
    }

    /**
     * Declarators before the first one that stays go with the comma after them.
     * The ones after it go with the comma before them.
     */
    let first = all.findIndex((/** @type {Node} */ d) => !removed.has(d));

    if (first > 0) edits.replace({ start: all[0].start, end: all[first].start }, "");

    for (let i = first + 1; i < all.length; i++) {
      if (removed.has(all[i])) edits.replace({ start: all[i - 1].end, end: all[i].end }, "");
    }
  }

  if (imports.modules.size === 0) {
    if (edits.size === 0) return { code: source, todo };

    if (remaining === 0 && emberImport.specifiers.length === 1) edits.removeLine(emberImport);

    return { code: edits.apply(), todo };
  }

  let raw = source.slice(emberImport.source.start, emberImport.source.end);
  let quote = raw.startsWith("'") ? "'" : '"';
  let semi = source.slice(emberImport.start, emberImport.end).trimEnd().endsWith(";") ? ";" : "";
  let lines = imports.lines(quote, semi).join("\n");

  if (remaining === 0 && emberImport.specifiers.length === 1) {
    edits.replace(emberImport, lines);
  } else {
    edits.insert(emberImport.end, `\n${lines}`);
  }

  return { code: edits.apply(), todo };
}
