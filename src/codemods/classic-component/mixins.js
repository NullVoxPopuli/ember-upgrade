import { posix } from "node:path";

import { parseProgram, SKIP, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { importMap, updateImports } from "#codemods/imports.js";

import { readClassicComponent } from "./read.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * @callback Resolve
 * @param {string} specifier an import specifier, such as `my-app/mixins/x` or `../mixins/x`
 * @param {string} from the file that imports it
 * @returns {{ file: string, source: string } | undefined} the app module, or undefined when an addon or a package has it
 */

/**
 * Properties that Ember merges when both the mixin and the class have them, instead of the class winning.
 */
const MERGED = new Set([
  "actions",
  "classNames",
  "classNameBindings",
  "attributeBindings",
  "concatenatedProperties",
  "mergedProperties",
]);

/**
 * @param {Node | undefined} node
 * @returns {string | undefined}
 */
function keyName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
}

/**
 * @param {Node} node
 * @returns {Set<string>} the names that the code uses as variables, not as keys
 */
function freeNames(node) {
  /** @type {Set<string>} */
  let names = new Set();

  walk(node, (child, parent) => {
    if (child.type !== "Identifier") return;

    let isKey =
      (parent?.type === "MemberExpression" && parent.property === child && !parent.computed) ||
      ((parent?.type === "Property" || parent?.type === "MethodDefinition") &&
        parent.key === child &&
        !parent.computed &&
        !(parent.type === "Property" && parent.shorthand));

    if (!isKey) names.add(child.name);
  });

  return names;
}

/**
 * @param {Node} node
 * @returns {Node[]} the `this._super` expressions of the function
 */
function superCalls(node) {
  /** @type {Node[]} */
  let found = [];

  walk(node, (child) => {
    if (
      child.type === "MemberExpression" &&
      child.object?.type === "ThisExpression" &&
      child.property?.name === "_super"
    ) {
      found.push(child);
      return SKIP;
    }
  });

  return found;
}

/**
 * @param {Node} node
 * @returns {boolean} the function calls `this._super`
 */
function callsSuper(node) {
  return superCalls(node).length > 0;
}

/**
 * @param {Node} program
 * @returns {Map<string, Node>} the top-level statements that declare each name, other than imports and exports
 */
function declarations(program) {
  /** @type {Map<string, Node>} */
  let map = new Map();

  for (let node of program.body) {
    if (node.type === "VariableDeclaration") {
      for (let declarator of node.declarations) {
        if (declarator.id?.type === "Identifier") map.set(declarator.id.name, node);
      }
    } else if (
      (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
      node.id
    ) {
      map.set(node.id.name, node);
    }
  }

  return map;
}

/**
 * @param {string} source
 * @param {Node} program
 * @returns {{ properties: Node[], program: Node } | { reason: string }}
 */
function readMixin(source, program) {
  let imports = importMap(program);
  let exported = program.body.find(
    (/** @type {Node} */ node) => node.type === "ExportDefaultDeclaration",
  )?.declaration;

  if (exported?.type === "Identifier") {
    exported = declarations(program)
      .get(exported.name)
      ?.declarations?.find((/** @type {Node} */ entry) => entry.id?.name === exported.name)?.init;
  }

  let callee = exported?.type === "CallExpression" ? exported.callee : undefined;
  let mixin = callee?.type === "MemberExpression" ? imports.get(callee.object?.name) : undefined;
  let isMixin = mixin?.module === "@ember/object/mixin" && callee.property?.name === "create";
  /**
   * A classic component that another one extends gives its properties in the same way.
   */
  let isComponent = mixin?.module === "@ember/component" && callee.property?.name === "extend";

  if (!mixin || mixin.imported !== "default" || !(isMixin || isComponent)) {
    return { reason: "the default export is not Mixin.create() or Component.extend()" };
  }

  /** @type {Node[]} */
  let properties = [];

  for (let arg of exported.arguments) {
    if (arg.type !== "ObjectExpression") {
      return { reason: `the mixin includes ${source.slice(arg.start, arg.end)}` };
    }

    for (let property of arg.properties) {
      if (property.type !== "Property" || property.computed || !keyName(property.key)) {
        return { reason: `the mixin has ${source.slice(property.start, property.end)}` };
      }

      properties.push(property);
    }
  }

  return { properties, program };
}

/**
 * @param {string} source
 * @param {Node} property
 * @param {string} indent the indentation of the component's properties
 * @param {string} [rename] a new key for the property
 * @returns {string} the property with the comments above it, at the indentation of the component
 */
function propertyText(source, property, indent, rename) {
  if (rename) {
    source = `${source.slice(0, property.key.start)}${rename}${source.slice(property.key.end)}`;
    property = {
      ...property,
      end: property.end + rename.length - (property.key.end - property.key.start),
    };
  }

  let lineStart = source.lastIndexOf("\n", property.start - 1) + 1;
  let own = /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "";
  let start = lineStart;
  let comments = /((?:[ \t]*(?:\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\n]*)[ \t]*\n)+)$/.exec(
    source.slice(0, lineStart),
  );

  if (comments?.[1]) start -= comments[1].length;

  return source
    .slice(start, property.end)
    .split("\n")
    .map((line) =>
      line.trim() === ""
        ? ""
        : indent + (line.startsWith(own) ? line.slice(own.length) : line.trimStart()),
    )
    .join("\n");
}

/**
 * @param {string} name the local name
 * @param {{ module: string, imported: string }} from
 * @returns {string}
 */
function importLine(name, from) {
  if (from.imported === "default") return `import ${name} from '${from.module}';`;
  if (from.imported === "*") return `import * as ${name} from '${from.module}';`;

  return from.imported === name
    ? `import { ${name} } from '${from.module}';`
    : `import { ${from.imported} as ${name} } from '${from.module}';`;
}

/**
 * Copies the properties of the app's mixins into the classic component that uses them, as `Component.extend(Mixin, {})` combined them.
 * The mixin's imports and module constants that the properties use come along. Mixins of addons stay.
 *
 * @param {string} source the component module
 * @param {string} file
 * @param {Resolve} resolve
 * @returns {{ source: string, unreadable: string[] }} the source does not change when a reason is in `unreadable`
 */
export function inlineMixins(source, file, resolve) {
  let component = readClassicComponent(source, file);

  if (!component || component.mixins.length === 0 || component.form !== "extend") {
    return { source, unreadable: [] };
  }

  let program = parseProgram(source, file);

  if (!program) return { source, unreadable: [] };

  let imports = importMap(program);
  let ownDeclarations = declarations(program);
  let ownMembers = new Map(component.members.map((member) => [member.name, member]));
  /** @type {string[]} */
  let unreadable = [];
  /** @type {string[]} */
  let copied = [];
  /**
   * Named imports by module, with `default:Name` for a default import, and the lines for the other imports.
   * @type {Map<string, Set<string>>}
   */
  let add = new Map();
  /** @type {Map<string, string>} */
  let newImports = new Map();
  /** @type {Map<string, { start: number, text: string }>} */
  let newDeclarations = new Map();
  /** @type {Set<string>} */
  let seen = new Set();
  /** @type {{ node: Node, text: string }[]} */
  let superEdits = [];

  let call = component.node;
  let object = call.arguments.find((/** @type {Node} */ arg) => arg.type === "ObjectExpression");
  let indent = "  ";

  if (object?.properties[0]) {
    let first = object.properties[0];

    indent =
      /^[ \t]*/.exec(source.slice(source.lastIndexOf("\n", first.start - 1) + 1))?.[0] ?? indent;
  }

  for (let name of component.mixins) {
    let from = imports.get(name);
    let resolved = from?.imported === "default" ? resolve(from.module, file) : undefined;

    if (!from || !resolved) {
      unreadable.push(`the mixin ${name} is not a module of the app`);
      continue;
    }

    let mixinProgram = parseProgram(resolved.source, resolved.file);
    let mixin = mixinProgram
      ? readMixin(resolved.source, mixinProgram)
      : { reason: "it does not parse" };

    if ("reason" in mixin) {
      unreadable.push(`the mixin ${name}: ${mixin.reason}`);
      continue;
    }

    let mixinImports = importMap(mixin.program);
    let mixinDeclarations = declarations(mixin.program);
    /** @type {Node[]} */
    let used = [];

    for (let property of mixin.properties) {
      let key = String(keyName(property.key));
      let own = ownMembers.get(key);

      if (seen.has(key)) {
        unreadable.push(`two mixins have ${key}`);
        continue;
      }

      seen.add(key);

      let outer = /** @type {Record<string, unknown>} */ (component.outerHtml)[key];

      if (MERGED.has(key) && (own || (Array.isArray(outer) && outer.length > 0))) {
        /**
         * The reader keeps the element's properties, such as `classNames`, out of the members.
         */
        let ownProperty =
          own?.node ??
          object?.properties.find((/** @type {Node} */ entry) => keyName(entry.key) === key);
        let merged = ownProperty
          ? mergeProperty(resolved.source, property, source, ownProperty)
          : undefined;

        if (merged === undefined) {
          unreadable.push(`the mixin ${name} and the component both have ${key}`);
          continue;
        }

        superEdits.push({ node: ownProperty.value, text: merged });
        used.push(property);
        continue;
      }

      if (own && callsSuper(own.node)) {
        let fn = property.method ? property : property.value;

        if (!property.method && fn?.type !== "FunctionExpression") {
          unreadable.push(
            `${key} of the component calls _super, and ${key} of the mixin ${name} is not a function`,
          );
          continue;
        }

        /**
         * The component's `this._super()` ran the mixin's version, which stays under its own name.
         */
        let renamed = `${name.charAt(0).toLowerCase()}${name.slice(1)}${key.charAt(0).toUpperCase()}${key.slice(1)}`;

        if (ownMembers.has(renamed)) {
          unreadable.push(`the component has ${renamed}`);
          continue;
        }

        for (let call of superCalls(own.node))
          superEdits.push({ node: call, text: `this.${renamed}` });

        copied.push(propertyText(resolved.source, property, indent, renamed));
        used.push(property);
        continue;
      }

      if (own) continue;

      copied.push(propertyText(resolved.source, property, indent));
      used.push(property);
    }

    /**
     * The names that the copied code reads, and the module bindings that they need, with the bindings that those read.
     */
    let pending = used.flatMap((property) => Array.from(freeNames(property)));
    /** @type {Set<string>} */
    let done = new Set();

    while (pending.length > 0) {
      let local = String(pending.pop());

      if (done.has(local)) continue;
      done.add(local);

      let imported = mixinImports.get(local);
      let declared = mixinDeclarations.get(local);

      if (imported) {
        let module = imported.module.startsWith(".")
          ? relativeSpecifier(file, posix.join(posix.dirname(resolved.file), imported.module))
          : imported.module;
        let have = imports.get(local);

        if (have && (have.module !== module || have.imported !== imported.imported)) {
          unreadable.push(`${local} of the mixin ${name} is another import in the component`);
        } else if (!have && (imported.imported === local || imported.imported === "default")) {
          let names = add.get(module) ?? new Set();

          names.add(imported.imported === "default" ? `default:${local}` : local);
          add.set(module, names);
        } else if (!have) {
          newImports.set(local, importLine(local, { module, imported: imported.imported }));
        }
      } else if (declared) {
        if (ownDeclarations.has(local)) {
          unreadable.push(`${local} of the mixin ${name} is another binding in the component`);
          continue;
        }

        newDeclarations.set(local, {
          start: declared.start,
          text: resolved.source.slice(declared.start, declared.end),
        });

        for (let next of freeNames(declared)) pending.push(next);
      }
    }
  }

  if (unreadable.length > 0) return { source, unreadable };

  let edits = new Edits(source);
  let body = copied.map((text) => `${text},`).join("\n\n");

  let mixinArgs = call.arguments.filter(
    (/** @type {Node} */ arg) => arg.type === "Identifier" && component.mixins.includes(arg.name),
  );

  if (object && object.properties.length === 0) {
    edits.replace(object, `{\n${body}\n}`);
  } else if (object) {
    let lineBreak = /^[ \t]*\n/.exec(source.slice(object.start + 1));

    edits.replace(
      { start: object.start, end: object.start + 1 + (lineBreak?.[0].length ?? 0) },
      `{\n${body}\n\n${lineBreak ? "" : indent}`,
    );
  }

  if (object) {
    for (let arg of mixinArgs) {
      let next = call.arguments[call.arguments.indexOf(arg) + 1];

      if (next) edits.replace({ start: arg.start, end: next.start }, "");
    }
  } else if (mixinArgs.length > 0) {
    edits.replace(
      { start: mixinArgs[0].start, end: mixinArgs[mixinArgs.length - 1].end },
      `{\n${body}\n}`,
    );
  }

  /** @type {Set<Node>} */
  let removed = new Set();

  for (let node of program.body) {
    if (node.type !== "ImportDeclaration" || node.specifiers?.length !== 1) continue;

    if (mixinArgs.some((/** @type {Node} */ arg) => arg.name === node.specifiers[0].local.name)) {
      edits.removeLine(node);
      removed.add(node);
    }
  }

  /**
   * New imports go after the last import that stays, so that they do not touch a removed line.
   */
  let lastImport = program.body.findLast(
    (/** @type {Node} */ node) => node.type === "ImportDeclaration" && !removed.has(node),
  );
  let header = Array.from(newImports.values()).join("\n");
  let constants = Array.from(newDeclarations.values())
    .sort((a, b) => a.start - b.start)
    .map((entry) => entry.text)
    .join("\n");

  if (lastImport) {
    edits.insert(
      lastImport.end,
      `${header ? `\n${header}` : ""}${constants ? `\n\n${constants}` : ""}`,
    );
  } else if (header || constants) {
    edits.insert(0, `${[header, constants].filter(Boolean).join("\n\n")}\n\n`);
  }

  for (let { node, text } of superEdits) edits.replace(node, text);

  return { source: updateImports(edits.apply(), file, { prune: [], add }), unreadable };
}

/**
 * @param {string} from the importing file, such as `app/components/x.js`
 * @param {string} target the file that the specifier names, without the extension
 * @returns {string}
 */
function relativeSpecifier(from, target) {
  let specifier = posix.relative(posix.dirname(from), target);

  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

/**
 * Ember concatenates the arrays of `classNames` and the other concatenated properties, and merges the `actions` objects.
 *
 * @param {string} mixinSource
 * @param {Node} mixinProperty
 * @param {string} source
 * @param {Node} ownProperty
 * @returns {string | undefined} the merged value, or undefined when the values are not literals that merge
 */
function mergeProperty(mixinSource, mixinProperty, source, ownProperty) {
  let theirs = mixinProperty.value;
  let ours = ownProperty.value;
  let text = (/** @type {string} */ from, /** @type {Node} */ node) =>
    from.slice(node.start, node.end);

  if (theirs?.type === "ArrayExpression" && ours?.type === "ArrayExpression") {
    let elements = theirs.elements
      .map((/** @type {Node} */ node) => text(mixinSource, node))
      .concat(ours.elements.map((/** @type {Node} */ node) => text(source, node)));

    return `[${elements.join(", ")}]`;
  }

  if (theirs?.type !== "ObjectExpression" || ours?.type !== "ObjectExpression") return;

  let names = new Set(ours.properties.map((/** @type {Node} */ node) => keyName(node.key)));

  for (let node of theirs.properties) {
    let key = keyName(node.key);
    let mine = ours.properties.find((/** @type {Node} */ entry) => keyName(entry.key) === key);

    if (node.type !== "Property" || node.computed || !key) return;
    if (mine && callsSuper(mine)) return;
  }

  let entries = theirs.properties
    .filter((/** @type {Node} */ node) => !names.has(keyName(node.key)))
    .map((/** @type {Node} */ node) => text(mixinSource, node))
    .concat(ours.properties.map((/** @type {Node} */ node) => text(source, node)));

  return `{\n${entries.map((/** @type {string} */ entry) => `    ${entry},`).join("\n\n")}\n  }`;
}

/**
 * A classic component that extends another classic component of the app, such as `StripeElement.extend({})`,
 * gets the properties of that component, as a mixin's, and extends `Component`.
 * The superclass of an addon stays.
 *
 * @param {string} source the component module
 * @param {string} file
 * @param {Resolve} resolve
 * @returns {{ source: string, unreadable: string[] }}
 */
export function inlineSuperclass(source, file, resolve) {
  let program = parseProgram(source, file);
  let component = program ? readSubclass(program) : undefined;

  if (!program || !component) return { source, unreadable: [] };

  let { call, local, module } = component;
  let resolved = resolve(module, file);

  if (!resolved) return { source, unreadable: [] };

  /**
   * The superclass can extend another one, and use mixins.
   */
  let base = inlineSuperclass(resolved.source, resolved.file, resolve);
  let baseMixins = base.unreadable.length
    ? base
    : inlineMixins(base.source, resolved.file, resolve);

  if (baseMixins.unreadable.length > 0) {
    return {
      source,
      unreadable: baseMixins.unreadable.map((reason) => `the superclass ${local}: ${reason}`),
    };
  }

  let imports = importMap(program);
  let componentLocal = Array.from(imports).find(
    ([, value]) => value.module === "@ember/component" && value.imported === "default",
  )?.[0];
  let edits = new Edits(source);
  let name = componentLocal ?? "Component";

  edits.replace(call.callee, `${name}.extend`);

  if (call.arguments.length > 0) {
    edits.insert(call.arguments[0].start, `${local}, `);
  } else {
    edits.insert(call.end - 1, local);
  }

  if (!componentLocal) edits.insert(0, "import Component from '@ember/component';\n");

  let rewritten = edits.apply();
  let target = resolved.file;

  return inlineMixins(rewritten, file, (specifier, from) =>
    specifier === module && from === file
      ? { file: target, source: baseMixins.source }
      : resolve(specifier, from),
  );
}

/**
 * @param {Node} program
 * @returns {{ call: Node, local: string, module: string } | undefined} the default export, when it is `Local.extend()` of a default import that is not `@ember/component`
 */
function readSubclass(program) {
  let imports = importMap(program);
  let exported = program.body.find(
    (/** @type {Node} */ node) => node.type === "ExportDefaultDeclaration",
  )?.declaration;

  if (exported?.type === "Identifier") {
    exported = declarations(program)
      .get(exported.name)
      ?.declarations?.find((/** @type {Node} */ entry) => entry.id?.name === exported.name)?.init;
  }

  let callee = exported?.type === "CallExpression" ? exported.callee : undefined;

  if (callee?.type !== "MemberExpression" || callee.property?.name !== "extend") return;
  if (callee.object?.type !== "Identifier") return;

  let from = imports.get(callee.object.name);

  if (!from || from.imported !== "default" || from.module.startsWith("@ember/")) return;

  return { call: exported, local: callee.object.name, module: from.module };
}
