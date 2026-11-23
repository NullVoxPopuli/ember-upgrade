import { parseProgram, SKIP, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { importMap, updateImports } from "#codemods/imports.js";
import { NestedEdits } from "#codemods/nested-edits.js";

import { COMPONENT_API } from "./args.js";
import { macroGetter, readPath } from "./macros.js";
import { EVENTS } from "./outer-html.js";
import { readClassicComponent } from "./read.js";
import { ACTION_HANDLER, ACTION_VALUE } from "./template.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('./read.js').ClassicComponent} ClassicComponent */
/** @typedef {import('./read.js').Member} Member */
/** @typedef {import('./args.js').Names} Names */

const NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * One level of indentation in generated code, which becomes the class body's own indentation.
 */
const INDENT = "\u21e5";

/**
 * The hooks that run when the element is inserted or removed. The Glimmer version runs them from a modifier.
 */
const ELEMENT_HOOKS = new Set(["didInsertElement", "willDestroyElement", "willClearRender"]);

/**
 * Hooks that have no Glimmer replacement yet, so the conversion stops.
 */
const UNSUPPORTED_HOOKS = new Set([
  "didUpdateAttrs",
  "willRender",
  "willUpdate",
  "didUpdate",
  "didRender",
  "willInsertElement",
  "didDestroyElement",
]);

/**
 * The modules whose imports the conversion can make unused.
 */
const PRUNE = [
  "@ember/component",
  "@ember/object",
  "@ember/object/computed",
  "@ember/object/evented",
  "ember-classic-decorator",
  "@ember-decorators/component",
  "@ember-decorators/object",
  "ember-computed",
];

/**
 * The modules that export the computed macros. `ember-computed` is the shim from before the module API.
 */
const MACRO_MODULES = new Set(["@ember/object/computed", "ember-computed"]);

/**
 * @typedef {object} Glimmer
 * @property {string} source the new module
 * @property {string[]} unreadable the reasons that the conversion stopped; the source is the old one then
 * @property {string | undefined} modifier the field that the template puts on its element, such as `lifecycle`
 * @property {{ name: string, args: string[] }[]} helpers methods that the template calls at its start, with the paths that they track
 * @property {boolean} elementId the template's element needs `id={{this.elementId}}`
 */

/**
 * @param {string} key
 * @returns {string} the key as a member access on `this`
 */
function member(key) {
  return NAME.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/**
 * @param {string} key
 * @returns {string} the key as a class member name
 */
function memberName(key) {
  return NAME.test(key) ? key : JSON.stringify(key);
}

/**
 * @param {Node | undefined} node
 * @returns {string | undefined} `x` for `this.x` and `this['x']`
 */
function thisKey(node) {
  if (node?.type !== "MemberExpression" || node.object?.type !== "ThisExpression") return;

  if (!node.computed && node.property?.type === "Identifier") return node.property.name;

  if (node.property?.type === "Literal" && typeof node.property.value === "string") {
    return node.property.value;
  }
}

/**
 * @param {Node | undefined} node
 * @returns {boolean} `this._super(...)`, `this._super.apply(this, arguments)`, or `super.x(...)`
 */
function isSuperCall(node) {
  if (node?.type !== "CallExpression") return false;

  let callee = node.callee;

  if (callee?.type === "MemberExpression" && callee.object?.type === "Super") return true;
  if (thisKey(callee) === "_super") return true;

  return (
    callee?.type === "MemberExpression" &&
    thisKey(callee.object) === "_super" &&
    (callee.property?.name === "apply" || callee.property?.name === "call")
  );
}

/**
 * The first pass: rewrites what the methods do with `this`, while the members stay where they are.
 *
 * @param {string} source
 * @param {ClassicComponent} component
 * @param {Names} names
 * @param {string[]} unreadable
 * @returns {string}
 */
function rewriteThis(source, component, names, unreadable) {
  let edits = new NestedEdits(source);
  let members = new Set(component.members.map((entry) => entry.name));
  let text = (/** @type {Node} */ node) => edits.print(node);

  walk(component.chain, (node, parent) => {
    if (node.type === "AssignmentExpression") {
      let key = thisKey(node.left);
      let callback = key === undefined ? undefined : names.callbacks.get(key);

      if (callback && node.operator === "=") {
        edits.replace(node, () => `this.args.${callback}?.(${text(node.right)})`);
        return;
      }
    }

    /**
     * `get(this, 'a.b')` and `set(this, 'a.b', value)`, from the accessor rewrite, where `a` is an argument.
     */
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      (node.callee.name === "get" || node.callee.name === "set") &&
      node.arguments[0]?.type === "ThisExpression" &&
      node.arguments[1]?.type === "Literal" &&
      typeof node.arguments[1].value === "string"
    ) {
      let [head = "", ...rest] = node.arguments[1].value.split(".");

      if (names.args.has(head) && !members.has(head)) {
        let quote = source.charAt(node.arguments[1].start);
        let value = node.arguments[2];

        edits.replace(node, () =>
          node.callee.name === "get"
            ? `get(this.args, ${quote}${node.arguments[1].value}${quote})`
            : `set(this.args${member(head)}, ${quote}${rest.join(".")}${quote}, ${value ? text(value) : "undefined"})`,
        );
        return;
      }
    }

    if (node.type === "CallExpression" && thisKey(node.callee) === "send") {
      let [first, ...rest] = node.arguments;

      if (first?.type !== "Literal" || typeof first.value !== "string") {
        unreadable.push(`this.send with a dynamic name: ${source.slice(node.start, node.end)}`);
        return;
      }

      edits.replace(
        node,
        () =>
          `this${member(first.value)}(${rest.map((/** @type {Node} */ arg) => text(arg)).join(", ")})`,
      );
      return;
    }

    let key = thisKey(node);

    if (key === undefined) return;

    if (key === "attrs" && parent?.type === "MemberExpression" && parent.object === node) {
      let name = thisKey({ ...parent, object: { type: "ThisExpression" } });

      if (name !== undefined) {
        edits.replace(parent, () => `this.args${member(name)}`);
        return;
      }
    }

    if (names.args.has(key) && !members.has(key) && !names.getters) {
      if (parent?.type === "AssignmentExpression" && parent.left === node) return;

      edits.replace(node, () => `this.args${member(key)}`);
    }
  });

  return edits.apply();
}

/**
 * @param {string} source
 * @param {Node} fn a function
 * @param {string} name the method that the function was
 * @param {string[]} unreadable
 * @returns {string} the body, without its braces, and without calls to the classic super method
 */
function bodyOf(source, fn, name, unreadable) {
  let body = fn.body;

  if (body?.type !== "BlockStatement") {
    unreadable.push(`${name} is not a function with a block body`);
    return "";
  }

  let edits = new Edits(source);

  for (let statement of body.body) {
    if (statement.type === "ExpressionStatement" && isSuperCall(statement.expression)) {
      edits.removeLine(statement);
    }
  }

  walk(body, (node) => {
    if (node.type === "ExpressionStatement" && isSuperCall(node.expression)) return SKIP;

    if (thisKey(node) === "_super") unreadable.push(`${name} calls _super in an expression`);
  });

  let text = edits.size > 0 ? edits.apply() : source;
  let removed = source.length - text.length;

  /**
   * The blank line after a removed super call goes too.
   */
  return text.slice(body.start + 1, body.end - 1 - removed).replace(/^\n[ \t]*\n/, "\n");
}

/**
 * The part of a method before its body, such as `async *save(a, b = 1): Promise<void>`.
 * A method keeps its own text, with its modifiers and types. A function value, such as `save: function (a) {}`, gets a method header.
 *
 * @param {string} source
 * @param {Node} node the class member or object property
 * @param {Node} fn the method's function
 * @param {string} key
 * @returns {string}
 */
function methodHeader(source, node, fn, key) {
  let decorators = node.decorators ?? [];
  let start = decorators.length > 0 ? decorators[decorators.length - 1].end : node.start;

  if (node.type === "MethodDefinition" || (node.type === "Property" && node.method)) {
    return source.slice(start, fn.body.start).trim();
  }

  let open = source.indexOf("(", fn.id ? fn.id.end : fn.start);
  let rest = source
    .slice(open, fn.body.start)
    .trim()
    .replace(/\s*=>$/, "");

  return `${fn.async ? "async " : ""}${fn.generator ? "*" : ""}${key}${rest}`;
}

/**
 * @param {string} source
 * @param {Member} entry
 * @returns {{ fn: Node, key: string } | undefined} the function of a method member, and its key as written
 */
function methodParts(source, entry) {
  let node = entry.node;
  let key = node.key ? source.slice(node.key.start, node.key.end) : memberName(entry.name);
  let fn = node.value;

  if (entry.kind === "on" || entry.kind === "observer" || entry.kind === "computed") {
    let args = fn?.arguments ?? [];

    fn = args[args.length - 1];

    if (entry.observes) fn = fn?.arguments?.[fn.arguments.length - 1];
  }

  if (fn?.type !== "FunctionExpression" && fn?.type !== "ArrowFunctionExpression") return;

  return { fn, key: node.computed ? `[${key}]` : key };
}

/**
 * @param {string} source
 * @param {Node} node a class member or object property
 * @returns {string} the comments before it
 */
function leadingComments(source, node) {
  let before = source.slice(0, node.start);
  let match = /((?:[ \t]*(?:\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\n]*)[ \t]*\n)+)[ \t]*$/.exec(before);

  return match?.[1] ?? "";
}

/**
 * @param {string} decorator such as `computed('a')` or `action`
 * @returns {string} the called name, such as `computed`
 */
function decoratorName(decorator) {
  return decorator.replace(/^\(/, "").split(/[(.]/)[0] ?? decorator;
}

/**
 * @param {string} source
 * @param {Member} entry a class member
 * @returns {string} its source, without its decorators
 */
function withoutDecorators(source, entry) {
  let decorators = entry.node.decorators ?? [];
  let start = decorators.length > 0 ? decorators[decorators.length - 1].end : entry.node.start;

  return source.slice(start, entry.node.end).trimStart();
}

/**
 * @param {string} source
 * @param {Node} call a macro call, such as `alias('a.b')`
 * @param {Map<string, { module: string, imported: string }>} imports
 * @param {(key: string) => string} root the object that a dependent key starts at, such as `this.args`
 * @returns {ReturnType<typeof macroGetter>}
 */
function macroOf(source, call, imports, root) {
  if (call?.type !== "CallExpression") return;

  let callee = call.callee;
  let name;

  if (callee?.type === "Identifier") {
    let from = imports.get(callee.name);

    if (!from || !MACRO_MODULES.has(from.module)) return;

    name = from.imported;
  } else if (
    callee?.type === "MemberExpression" &&
    callee.object?.type === "Identifier" &&
    ((imports.get(callee.object.name)?.module === "@ember/object" &&
      imports.get(callee.object.name)?.imported === "computed") ||
      imports.get(callee.object.name)?.module === "ember-computed")
  ) {
    name = callee.property?.name;
  }

  if (!name) return;

  return macroGetter(
    {
      name,
      args: call.arguments.map((/** @type {Node} */ arg) => ({
        text: source.slice(arg.start, arg.end),
        string: arg.type === "Literal" && typeof arg.value === "string" ? arg.value : undefined,
      })),
    },
    root,
  );
}

/**
 * Converts a classic component module into a Glimmer component module.
 *
 * @param {string} input the module, after {@link import('./accessors.js').rewriteAccessors}
 * @param {string} file
 * @param {Names} names
 * @param {{ templateReads: Set<string>, imports?: Set<string>, actionHandler?: boolean, actionValue?: boolean }} options the keys that the template reads, the names that the accessor rewrite needs from `@ember/object`, and whether the template needs {@link ACTION_HANDLER} or {@link ACTION_VALUE}
 * @returns {Glimmer}
 */
export function toGlimmer(input, file, names, options) {
  /** @type {Glimmer} */
  let result = {
    source: input,
    unreadable: [],
    modifier: undefined,
    helpers: [],
    elementId: false,
  };
  let first = readClassicComponent(input, file);

  if (!first) {
    result.unreadable.push("not a classic component");
    return result;
  }

  if (first.mixins.length > 0) result.unreadable.push(`mixins: ${first.mixins.join(", ")}`);
  if (first.unreadable.length > 0) result.unreadable.push(...first.unreadable);
  if (names.conflicts.size > 0) {
    result.unreadable.push(
      `callers pass a method or getter: ${Array.from(names.conflicts).join(", ")}`,
    );
  }

  let program = parseProgram(input, file);

  if (!program || result.unreadable.length > 0) return result;

  let superClass = importMap(program).get(first.superClass);

  if (superClass?.module !== "@ember/component") {
    result.unreadable.push(`extends ${first.superClass}, not the Component of @ember/component`);
    return result;
  }

  let source = rewriteThis(input, first, names, result.unreadable);
  let component = readClassicComponent(source, file);

  program = parseProgram(source, file);

  if (!component || !program || result.unreadable.length > 0) {
    if (result.unreadable.length === 0) result.unreadable.push("the rewrite does not parse");
    return result;
  }

  let imports = importMap(program);
  /** @type {Map<string, Set<string>>} */
  let add = new Map();
  let need = (/** @type {string} */ module, /** @type {string} */ name) => {
    let set = add.get(module) ?? new Set();

    set.add(name);
    add.set(module, set);
  };

  for (let name of options.imports ?? []) need("@ember/object", name);

  let members = component.members;
  let has = (/** @type {string} */ name) => members.some((entry) => entry.name === name);
  let usesElement = false;
  let usesElementId = false;

  walk(component.node, (node) => {
    let key = thisKey(node);

    if (key === "element") usesElement = true;
    if (key === "elementId") usesElementId = true;
    if (key === "$") result.unreadable.push("uses jQuery through this.$");
  });

  if (options.templateReads.has("elementId")) usesElementId = true;

  /** @type {string[]} */
  let body = [];
  /** @type {string[]} */
  let constructorCalls = [];
  /** @type {Member[]} */
  let elementHooks = [];
  let init = "";
  let actionNames = new Set(options.templateReads);

  for (let entry of members) {
    if (entry.kind === "method" && EVENTS.has(entry.name)) actionNames.add(entry.name);
  }

  let emitMethod = (
    /** @type {Member} */ entry,
    /** @type {boolean} */ bound,
    /** @type {string} */ comments,
    /** @type {number} */ indent = 0,
  ) => {
    let parts = methodParts(source, entry);

    if (!parts) {
      result.unreadable.push(`${entry.name} is not a function`);
      return;
    }

    let kept = entry.decorators.filter((decorator) => decoratorName(decorator) !== "action");
    let lines = kept.map((decorator) => `\u21e5@${decorator}\n`).join("");

    if (bound || entry.decorators.some((decorator) => decoratorName(decorator) === "action")) {
      need("@ember/object", "action");
      lines += "\u21e5@action\n";
    }

    let code = bodyOf(source, parts.fn, entry.name, result.unreadable);

    /**
     * Methods of the `actions` object were one level deeper.
     */
    if (indent > 0) code = code.replaceAll(`\n${" ".repeat(indent)}`, "\n");

    let header = methodHeader(source, entry.node, parts.fn, parts.key);

    body.push(`${comments}${lines}\u21e5${header} {${code}}`);
  };

  for (let entry of members) {
    let comments = leadingComments(source, entry.node);
    let name = entry.name;

    if (names.args.has(name)) {
      let fallback = names.defaults.get(name);
      let read = `this.args${member(name)}`;

      body.push(
        `${comments}\u21e5get ${memberName(name)}() {\n\u21e5\u21e5return ${fallback ? `${read} ?? ${fallback.startsWith("() =>") ? `(${fallback})` : fallback}` : read};\n\u21e5}`,
      );
      continue;
    }

    if (name === "init" && entry.kind === "method") {
      let parts = methodParts(source, entry);

      if (!parts) {
        result.unreadable.push("init is not a function");
        continue;
      }

      init = bodyOf(source, parts.fn, name, result.unreadable).trimEnd();
      continue;
    }

    if (name === "constructor") {
      result.unreadable.push("the class has a constructor");
      continue;
    }

    if (UNSUPPORTED_HOOKS.has(name)) {
      result.unreadable.push(`the ${name} hook`);
      continue;
    }

    if (ELEMENT_HOOKS.has(name) && entry.kind === "method") {
      elementHooks.push(entry);
      emitMethod(entry, false, comments);
      continue;
    }

    if (name === "didReceiveAttrs" && entry.kind === "method") {
      result.helpers.push({
        name,
        args: Array.from(names.args)
          .filter((arg) => NAME.test(arg))
          .map((arg) => `@${arg}`),
      });
      emitMethod(entry, true, comments);
      continue;
    }

    switch (entry.kind) {
      case "method": {
        emitMethod(entry, actionNames.has(name), comments);
        break;
      }

      case "actions": {
        for (let property of entry.node.value.properties ?? []) {
          let key = property.key?.name ?? property.key?.value;

          if (typeof key !== "string") {
            result.unreadable.push("an action with a computed name");
            continue;
          }

          if (has(key)) result.unreadable.push(`the action ${key} has the name of a member`);

          emitMethod(
            {
              name: key,
              kind: "method",
              source: "",
              value: undefined,
              keys: [],
              decorators: [],
              node: property,
            },
            true,
            leadingComments(source, property).replaceAll(/^ {2}/gm, ""),
            2,
          );
        }
        break;
      }

      case "getter":
      case "setter": {
        let computed = entry.decorators.find(
          (decorator) => decoratorName(decorator) === "computed",
        );
        let kept = entry.decorators.filter((decorator) => decoratorName(decorator) !== "computed");
        let lines = kept.map((decorator) => `\u21e5@${decorator}\n`).join("");

        if (computed === "computed") {
          need("@glimmer/tracking", "cached");
          lines += "\u21e5@cached\n";
        }

        let text = component.form === "class" ? withoutDecorators(source, entry) : entry.source;

        body.push(`${comments}${lines}\u21e5${text}`);
        break;
      }

      case "computed": {
        let parts = methodParts(source, entry);

        if (!parts) {
          result.unreadable.push(`the computed ${name} has no getter function`);
          break;
        }

        let cached = entry.keys.length === 0;

        if (cached) need("@glimmer/tracking", "cached");

        body.push(
          `${comments}${cached ? "\u21e5@cached\n" : ""}\u21e5get ${parts.key}() {${bodyOf(source, parts.fn, name, result.unreadable)}}`,
        );
        break;
      }

      case "on": {
        if (entry.observes) {
          result.helpers.push({
            name,
            args: entry.observes.map((key) => readPath(key.replace(/\.(\[\]|@each.*)$/, ""))),
          });
        } else if (entry.keys.length === 1 && entry.keys[0] === "init") {
          constructorCalls.push(`this${member(name)}();`);
        } else if (entry.keys.length === 1 && ELEMENT_HOOKS.has(String(entry.keys[0]))) {
          elementHooks.push(entry);
        } else {
          result.unreadable.push(`on(${entry.keys.join(", ")})`);
          break;
        }

        emitMethod(entry, entry.observes !== undefined, comments);
        break;
      }

      case "observer": {
        result.unreadable.push(`the observer ${name}`);
        break;
      }

      case "field": {
        let decorator = entry.decorators[0];
        let call = component.form === "class" ? undefined : entry.node.value;
        let macroCall =
          component.form === "class" && decorator
            ? entry.node.decorators[0]?.expression
            : entry.node.value;
        let macro = macroOf(source, macroCall, imports, (key) =>
          names.args.has(key) && !has(key) ? "this.args" : "this",
        );

        if (macro) {
          for (let spec of macro.imports) {
            let [module = "", imported = ""] = spec.split(":");

            need(module, imported);
          }

          let text = `${comments}\u21e5get ${memberName(name)}() {\n\u21e5\u21e5return ${macro.body};\n\u21e5}`;

          if (macro.setter && names.tracked.has(name)) {
            result.unreadable.push(`the alias ${name} is set`);
          }

          body.push(text);
          break;
        }

        if (component.form === "class") {
          let text = withoutDecorators(source, entry);
          let lines = entry.decorators.map((value) => `\u21e5@${value}\n`).join("");

          if (names.tracked.has(name) && entry.decorators.length === 0) {
            need("@glimmer/tracking", "tracked");
            lines = "\u21e5@tracked\n";
          }

          body.push(`${comments}${lines}\u21e5${text}`);
          break;
        }

        let value = entry.value ?? "undefined";
        let from = call?.type === "CallExpression" ? imports.get(call.callee?.name) : undefined;

        if (
          from &&
          (from.module === "@ember/service" ||
            from.module === "@ember/controller" ||
            from.module === "ember-concurrency")
        ) {
          body.push(`${comments}\u21e5@${value}\n\u21e5${memberName(name)};`);
          break;
        }

        if (names.tracked.has(name)) {
          need("@glimmer/tracking", "tracked");
          body.push(`${comments}\u21e5@tracked ${memberName(name)} = ${value};`);
        } else {
          body.push(`${comments}\u21e5${memberName(name)} = ${value};`);
        }
        break;
      }
    }
  }

  for (let name of Array.from(names.declared).reverse()) {
    if (COMPONENT_API.has(name)) continue;

    if (names.tracked.has(name)) {
      need("@glimmer/tracking", "tracked");
      body.unshift(`\u21e5@tracked ${memberName(name)};`);
    } else {
      body.unshift(`\u21e5${memberName(name)};`);
    }
  }

  /**
   * Other code reads the component's properties, as the classic component had them.
   */
  if (names.getters) {
    let getters = Array.from(names.args)
      .filter((name) => !has(name))
      .map(
        (name) =>
          `\u21e5get ${memberName(name)}() {\n\u21e5\u21e5return this.args${member(name)};\n\u21e5}`,
      );

    body = getters.concat(body);
  }

  if (usesElementId) {
    need("@ember/object/internals", "guidFor");
    result.elementId = true;
    body.push("  get elementId() {\n    return guidFor(this);\n  }");
  }

  if (options.actionHandler) {
    if (has(ACTION_HANDLER)) result.unreadable.push(`the class has a ${ACTION_HANDLER} member`);

    body.push(
      `\u21e5/**\n\u21e5 * Runs an action as the \`{{action}}\` modifier did, without the event.\n\u21e5 */\n\u21e5${ACTION_HANDLER} =\n\u21e5\u21e5(run, options = {}) =>\n\u21e5\u21e5(event) => {\n\u21e5\u21e5\u21e5if (options.preventDefault !== false) event.preventDefault();\n\u21e5\u21e5\u21e5if (options.bubbles === false) event.stopPropagation();\n\n\u21e5\u21e5\u21e5return run();\n\u21e5\u21e5};`,
    );
  }

  if (options.actionValue) {
    if (has(ACTION_VALUE)) result.unreadable.push(`the class has a ${ACTION_VALUE} member`);

    body.push(
      `\u21e5/**\n\u21e5 * Calls an action with a value of the event, as the \`action\` helper did with \`value=\`.\n\u21e5 */\n\u21e5${ACTION_VALUE} = (run, path) => (event) =>\n\u21e5\u21e5run(path.split('.').reduce((value, key) => value?.[key], event));`,
    );
  }

  if (elementHooks.length > 0 || usesElement) {
    if (component.outerHtml.tagName === "") {
      result.unreadable.push("a component without an element uses the element hooks");
    }

    if (has("lifecycle") || has("element")) {
      result.unreadable.push("the class has a lifecycle or element member");
    }

    need("ember-modifier", "modifier");
    result.modifier = "lifecycle";

    let hookOf = (/** @type {Member} */ entry) =>
      entry.kind === "on" ? String(entry.keys[0]) : entry.name;
    let inserted = elementHooks
      .filter((entry) => hookOf(entry) === "didInsertElement")
      .map((entry) => `\u21e5\u21e5this${member(entry.name)}();\n`)
      .join("");
    let removed = elementHooks
      .filter((entry) => hookOf(entry) !== "didInsertElement")
      .map((entry) => `\u21e5\u21e5\u21e5this${member(entry.name)}();\n`)
      .join("");

    body.unshift(
      `\u21e5element = null;\n\n\u21e5lifecycle = modifier((element) => {\n\u21e5\u21e5this.element = element;\n${inserted}\n\u21e5\u21e5return () => {\n${removed}\u21e5\u21e5\u21e5this.element = null;\n\u21e5\u21e5};\n\u21e5});`,
    );
  }

  if (init || constructorCalls.length > 0) {
    let calls = constructorCalls.map((call) => `\n\u21e5\u21e5${call}`).join("");

    body.unshift(
      `\u21e5constructor(owner, args) {\n\u21e5\u21e5super(owner, args);${init}${calls}\n\u21e5}`,
    );
  }

  if (result.unreadable.length > 0) return result;

  let className =
    component.className ??
    (file
      .split("/")
      .pop()
      ?.replace(/\.\w+$/, "")
      .split(/[-_.]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("") ||
      "Component");
  /**
   * Generated lines take the indentation of the class body, so they line up with the members that keep their source.
   */
  let firstMember = members[0]?.node;
  let unit = firstMember
    ? (/^[ \t]*/.exec(source.slice(source.lastIndexOf("\n", firstMember.start - 1) + 1))?.[0] ??
      "  ")
    : "  ";
  let classText =
    `class ${className} extends ${component.superClass} {\n${body.join("\n\n")}\n}`.replaceAll(
      INDENT,
      unit || "  ",
    );
  let edits = new Edits(source);

  for (let decorator of component.node.decorators ?? []) edits.removeLine(decorator);

  if (component.form === "class") {
    edits.replace(component.node, classText);
  } else {
    let end = component.chain.end;

    /**
     * `export default Component.extend({});` ends with a semicolon, which a class declaration does not need.
     */
    let exported = program.body.find(
      (/** @type {Node} */ node) =>
        node.type === "ExportDefaultDeclaration" &&
        node.declaration?.start === component.chain.start,
    );

    if (exported && source.charAt(end) === ";") end += 1;

    edits.replace({ start: component.chain.start, end }, classText);
  }

  let output = edits.apply();
  let componentImport = program.body.find(
    (/** @type {Node} */ node) =>
      node.type === "ImportDeclaration" && node.source.value === "@ember/component",
  );

  if (componentImport) {
    output = output.replace(
      source.slice(componentImport.start, componentImport.end),
      `import ${component.superClass} from '@glimmer/component';`,
    );
  }

  result.source = updateImports(output, file, { prune: PRUNE, add });

  return result;
}
