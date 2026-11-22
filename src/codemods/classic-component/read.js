import { parseProgram } from "#ast.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * Settings of the element that a classic component renders around its template.
 */
const OUTER_HTML = new Set([
  "tagName",
  "classNames",
  "classNameBindings",
  "attributeBindings",
  "elementId",
  "ariaRole",
]);

/**
 * @typedef {object} Member
 * @property {string} name
 * @property {"field" | "method" | "getter" | "setter" | "computed" | "on" | "observer" | "actions"} kind
 * @property {string} source the member as it was written, such as `alignBaseline: true` or `click(event) { ... }`
 * @property {string | undefined} value the value of a field, or the function of a computed, `on`, or `observer`
 * @property {string[]} keys the dependent keys of a computed or observer, or the events of an `on`
 * @property {string[]} [observes] the keys that an observer inside an `on`, such as `on('init', observer('value', fn))`, also runs on
 * @property {string[]} decorators the decorators of a native class member, such as `action` or `tracked`
 * @property {Node} node
 */

/**
 * @typedef {object} ClassicComponent
 * @property {"extend" | "class"} form
 * @property {string | undefined} className
 * @property {string} superClass the local name of the classic Component, or another component it extends
 * @property {string[]} mixins
 * @property {Member[]} members
 * @property {{ tagName?: string, classNames: string[], classNameBindings: string[], attributeBindings: string[], elementId?: string, ariaRole?: string }} outerHtml
 * @property {string[]} positionalParams
 * @property {string[]} unreadable source that the reader does not understand
 * @property {Node} node the `extend` call or the class
 */

/**
 * @param {string} source
 * @param {Node | undefined} node
 * @returns {string}
 */
function sourceOf(source, node) {
  return node ? source.slice(node.start, node.end) : "";
}

/**
 * @param {Node | undefined} node
 * @returns {string | undefined}
 */
function keyName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
}

/**
 * @param {Node | undefined} node
 * @returns {string[] | undefined} the strings of an array literal of strings
 */
function strings(node) {
  if (node?.type !== "ArrayExpression") return;

  let values = node.elements.map((/** @type {Node} */ element) =>
    element?.type === "Literal" && typeof element.value === "string" ? element.value : undefined,
  );

  return values.every((/** @type {string | undefined} */ value) => value !== undefined)
    ? /** @type {string[]} */ (values)
    : undefined;
}

/**
 * @param {Node | undefined} node
 * @returns {string | undefined} the name of a called function, such as `computed` for `computed('a', fn)`
 */
function calleeName(node) {
  if (node?.type !== "CallExpression") return;

  let callee = node.callee;

  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression") return keyName(callee.property);
}

/**
 * @param {string} source
 * @param {Node} call `computed(...)`, `on(...)`, or `observer(...)`
 * @returns {{ keys: string[], value: string | undefined }}
 */
function wrapped(source, call) {
  let args = call.arguments ?? [];
  let last = args[args.length - 1];
  let fn = last && last.type !== "Literal" ? last : undefined;
  let keys = args
    .filter((/** @type {Node} */ arg) => arg !== fn)
    .map((/** @type {Node} */ arg) =>
      arg.type === "Literal" ? String(arg.value) : sourceOf(source, arg),
    );

  return { keys, value: fn ? sourceOf(source, fn) : undefined };
}

/**
 * @param {string} source
 * @param {string} name
 * @param {Node} value
 * @param {Node} node
 * @param {string[]} decorators
 * @returns {Member}
 */
function valueMember(source, name, value, node, decorators) {
  let callee = calleeName(value);
  let kind = /** @type {Member["kind"]} */ ("field");
  let keys = /** @type {string[]} */ ([]);
  let text = sourceOf(source, value);

  if (callee === "computed" || callee === "on" || callee === "observer") {
    kind = callee;

    /**
     * `on('init', observer('value', fn))` runs on both, so it reads as an `on` with the observer inside.
     */
    ({ keys, value: text } = /** @type {{ keys: string[], value: string }} */ (
      wrapped(source, value)
    ));

    let inner = value.arguments?.[value.arguments.length - 1];

    if (callee === "on" && calleeName(inner) === "observer") {
      let observer = wrapped(source, inner);

      return {
        name,
        kind,
        source: sourceOf(source, node),
        value: observer.value,
        keys,
        observes: observer.keys,
        decorators,
        node,
      };
    }
  } else if (value.type === "FunctionExpression" || value.type === "ArrowFunctionExpression") {
    kind = "method";
  } else if (name === "actions" && value.type === "ObjectExpression") {
    kind = "actions";
  }

  return { name, kind, source: sourceOf(source, node), value: text, keys, decorators, node };
}

/**
 * @param {string} source
 * @param {Node} object the object literal of `Component.extend({ ... })`
 * @param {ClassicComponent} component
 */
function readObject(source, object, component) {
  for (let property of object.properties ?? []) {
    let name = keyName(property.key);

    if (property.type !== "Property" || property.computed || !name) {
      component.unreadable.push(sourceOf(source, property));
      continue;
    }

    if (property.kind === "get" || property.kind === "set") {
      component.members.push({
        name,
        kind: property.kind === "get" ? "getter" : "setter",
        source: sourceOf(source, property),
        value: sourceOf(source, property.value),
        keys: [],
        decorators: [],
        node: property,
      });
      continue;
    }

    if (property.method) {
      component.members.push({
        name,
        kind: "method",
        source: sourceOf(source, property),
        value: sourceOf(source, property.value),
        keys: [],
        decorators: [],
        node: property,
      });
      continue;
    }

    if (readOuterHtml(name, property.value, component)) continue;

    component.members.push(valueMember(source, name, property.value, property, []));
  }
}

/**
 * @param {string} name
 * @param {Node | undefined} value
 * @param {ClassicComponent} component
 * @returns {boolean} the member is an outer HTML setting, which the component now has
 */
function readOuterHtml(name, value, component) {
  if (!OUTER_HTML.has(name)) return false;

  let outer = component.outerHtml;

  if (name === "tagName" || name === "elementId" || name === "ariaRole") {
    if (value?.type !== "Literal" || typeof value.value !== "string") return false;

    outer[name] = value.value;
    return true;
  }

  let list = strings(value);

  if (!list) return false;

  outer[/** @type {"classNames" | "classNameBindings" | "attributeBindings"} */ (name)] = list;
  return true;
}

/**
 * @param {string} source
 * @param {Node} node a class member, or a decorator
 * @returns {string[]} the names of its decorators, with their arguments, such as `tagName('')`
 */
function decoratorsOf(source, node) {
  return (node.decorators ?? []).map((/** @type {Node} */ decorator) =>
    sourceOf(source, decorator.expression),
  );
}

/**
 * @param {string} source
 * @param {Node} body the class body
 * @param {ClassicComponent} component
 */
function readClassBody(source, body, component) {
  for (let member of body.body ?? []) {
    let name = keyName(member.key);
    let decorators = decoratorsOf(source, member);

    if (!name || member.computed || member.key?.type === "PrivateIdentifier") {
      component.unreadable.push(sourceOf(source, member));
      continue;
    }

    if (member.static) {
      let list = strings(member.value);

      if (name === "positionalParams" && list) {
        component.positionalParams = list;
      } else {
        component.unreadable.push(sourceOf(source, member));
      }

      continue;
    }

    if (member.type === "MethodDefinition") {
      let kind = /** @type {Member["kind"]} */ (
        member.kind === "get" ? "getter" : member.kind === "set" ? "setter" : "method"
      );

      if (member.kind === "constructor") kind = "method";

      component.members.push({
        name,
        kind,
        source: sourceOf(source, member),
        value: sourceOf(source, member.value),
        keys: [],
        decorators,
        node: member,
      });
      continue;
    }

    if (!member.value) {
      component.members.push({
        name,
        kind: "field",
        source: sourceOf(source, member),
        value: undefined,
        keys: [],
        decorators,
        node: member,
      });
      continue;
    }

    if (decorators.length === 0 && readOuterHtml(name, member.value, component)) continue;

    component.members.push(valueMember(source, name, member.value, member, decorators));
  }
}

/**
 * Class decorators from @ember-decorators/component, such as `@tagName('')`.
 *
 * @param {string} source
 * @param {Node} node the class
 * @param {ClassicComponent} component
 */
function readClassDecorators(source, node, component) {
  for (let decorator of node.decorators ?? []) {
    let call = decorator.expression;
    let name = calleeName(call);
    let args = call?.arguments ?? [];
    let values = args.map((/** @type {Node} */ arg) =>
      arg.type === "Literal" && typeof arg.value === "string" ? arg.value : undefined,
    );

    if (
      !name ||
      !OUTER_HTML.has(name) ||
      values.some((/** @type {string | undefined} */ value) => value === undefined)
    ) {
      component.unreadable.push(sourceOf(source, decorator));
      continue;
    }

    let outer = component.outerHtml;

    if (name === "tagName" || name === "elementId" || name === "ariaRole") {
      outer[name] = String(values[0]);
    } else {
      outer[/** @type {"classNames" | "classNameBindings" | "attributeBindings"} */ (name)] =
        /** @type {string[]} */ (values);
    }
  }
}

/**
 * @param {Node} node
 * @returns {Node | undefined} the `X.extend(...)` call at the start of a chain such as `X.extend({}).reopenClass({})`
 */
function extendCall(node) {
  if (node?.type !== "CallExpression" || node.callee?.type !== "MemberExpression") return;

  if (keyName(node.callee.property) === "extend") return node;

  return extendCall(node.callee.object);
}

/**
 * @param {string} source
 * @param {Node} node the default export
 * @param {ClassicComponent} component
 */
function readReopenClass(source, node, component) {
  for (let call = node; call && call !== component.node; call = call.callee?.object) {
    if (keyName(call.callee?.property) !== "reopenClass") {
      component.unreadable.push(sourceOf(source, call));
      continue;
    }

    for (let property of call.arguments?.[0]?.properties ?? []) {
      let list = strings(property.value);

      if (keyName(property.key) === "positionalParams" && list) {
        component.positionalParams = list;
      } else {
        component.unreadable.push(sourceOf(source, property));
      }
    }
  }
}

/**
 * Reads the default export of a classic component module, in either form:
 * `Component.extend({ ... })`, with an optional `.reopenClass({ ... })`, or `class extends Component`.
 *
 * @param {string} source
 * @param {string} file
 * @param {string[]} [superClasses] the local names that the module imports classic components as
 * @returns {ClassicComponent | undefined} undefined when the default export is not a classic component
 */
export function readClassicComponent(source, file, superClasses) {
  let program = parseProgram(source, file);

  if (!program) return;

  let names = new Set(superClasses ?? classicImports(program));
  let exported = program.body.find(
    (/** @type {Node} */ node) => node.type === "ExportDefaultDeclaration",
  )?.declaration;

  if (exported?.type === "Identifier") {
    exported = program.body
      .flatMap((/** @type {Node} */ node) =>
        node.type === "VariableDeclaration"
          ? node.declarations
          : node.type === "ClassDeclaration"
            ? [node]
            : [],
      )
      .find((/** @type {Node} */ node) => node.id?.name === exported.name);
    exported = exported?.type === "VariableDeclarator" ? exported.init : exported;
  }

  if (!exported) return;

  if (exported.type === "ClassDeclaration" || exported.type === "ClassExpression") {
    let superClass =
      exported.superClass?.type === "Identifier" ? exported.superClass.name : undefined;

    if (!superClass || !names.has(superClass)) return;

    /** @type {ClassicComponent} */
    let component = {
      form: "class",
      className: exported.id?.name,
      superClass,
      mixins: [],
      members: [],
      outerHtml: { classNames: [], classNameBindings: [], attributeBindings: [] },
      positionalParams: [],
      unreadable: [],
      node: exported,
    };

    readClassDecorators(source, exported, component);
    readClassBody(source, exported.body, component);

    return component;
  }

  let call = extendCall(exported);
  let superClass = call?.callee.object?.type === "Identifier" ? call.callee.object.name : undefined;

  if (!call || !superClass || !names.has(superClass)) return;

  /** @type {ClassicComponent} */
  let component = {
    form: "extend",
    className: undefined,
    superClass,
    mixins: [],
    members: [],
    outerHtml: { classNames: [], classNameBindings: [], attributeBindings: [] },
    positionalParams: [],
    unreadable: [],
    node: call,
  };

  for (let arg of call.arguments) {
    if (arg.type === "ObjectExpression") {
      readObject(source, arg, component);
    } else if (arg.type === "Identifier") {
      component.mixins.push(arg.name);
    } else {
      component.unreadable.push(sourceOf(source, arg));
    }
  }

  readReopenClass(source, exported, component);

  return component;
}

/**
 * @param {Node} program
 * @returns {string[]} the local names of `@ember/component`'s default export
 */
function classicImports(program) {
  return program.body
    .filter(
      (/** @type {Node} */ node) =>
        node.type === "ImportDeclaration" && node.source.value === "@ember/component",
    )
    .flatMap((/** @type {Node} */ node) => node.specifiers)
    .filter((/** @type {Node} */ specifier) => specifier.type === "ImportDefaultSpecifier")
    .map((/** @type {Node} */ specifier) => specifier.local.name);
}
