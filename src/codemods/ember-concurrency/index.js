import { parseProgram, SKIP, walk } from "#ast.js";
import { importMap, updateImports } from "#codemods/imports.js";
import { NestedEdits } from "#codemods/nested-edits.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * The packages that export the task functions and decorators.
 */
const MODULES = new Set(["ember-concurrency", "ember-concurrency-decorators"]);

/**
 * The task decorators, and the option that each one sets.
 */
const DECORATORS = new Map([
  ["task", undefined],
  ["dropTask", "drop"],
  ["restartableTask", "restartable"],
  ["enqueueTask", "enqueue"],
  ["keepLatestTask", "keepLatest"],
]);

/**
 * The modifiers of a classic task, such as `.drop()`, that become an option with the value `true`.
 */
const FLAGS = new Set(["drop", "restartable", "enqueue", "keepLatest", "evented", "debug"]);

/**
 * The events that end a component or an object. A task stops when its object goes away, so `cancelOn` with them does nothing.
 */
export const DESTROY_EVENTS = new Set(["willDestroyElement", "willClearRender", "willDestroy"]);

/**
 * A task in the syntax before ember-concurrency 5, such as `task(function* () {}).drop()`.
 *
 * @typedef {object} LegacyTask
 * @property {Node} root the call of `task`
 * @property {Node} fn the generator function
 * @property {{ name: string, args: Node[], node: Node }[]} modifiers each modifier, such as `.drop()`, in order
 * @property {string[]} options the options of the modern task, such as `drop: true`
 * @property {{ name: string, args: Node[], node: Node }[]} hooks the `on` and `cancelOn` modifiers, which only work in classic classes
 * @property {string[]} unreadable
 */

/**
 * @param {Node} program
 * @returns {Map<string, string>} the local names of the task functions, and the export of each one
 */
export function taskImports(program) {
  /** @type {Map<string, string>} */
  let names = new Map();

  for (let [local, value] of importMap(program)) {
    if (MODULES.has(value.module) && DECORATORS.has(value.imported)) {
      names.set(local, value.imported);
    }
  }

  return names;
}

/**
 * @param {string} source
 * @param {Node | undefined} node
 * @param {Map<string, string>} names from {@link taskImports}
 * @returns {LegacyTask | undefined} the task, when the node is a call of `task` with a generator function and modifiers
 */
export function readLegacyTask(source, node, names) {
  /** @type {LegacyTask["hooks"]} */
  let hooks = [];
  /** @type {string[]} */
  let options = [];
  /** @type {string[]} */
  let unreadable = [];
  let call = node;

  while (call?.type === "ParenthesizedExpression") call = call.expression;

  /** @type {{ name: string, args: Node[], node: Node }[]} */
  let modifiers = [];

  while (
    call?.type === "CallExpression" &&
    call.callee?.type === "MemberExpression" &&
    !call.callee.computed &&
    call.callee.object?.type === "CallExpression"
  ) {
    modifiers.unshift({ name: call.callee.property.name, args: call.arguments, node: call });
    call = call.callee.object;
  }

  if (call?.type !== "CallExpression" || call.callee?.type !== "Identifier") return;
  if (names.get(call.callee.name) !== "task" || call.arguments.length !== 1) return;

  let fn = call.arguments[0];

  if (fn?.type !== "FunctionExpression" || !fn.generator) return;

  for (let modifier of modifiers) {
    let args = modifier.args.map((/** @type {Node} */ arg) => source.slice(arg.start, arg.end));

    if (FLAGS.has(modifier.name) && args.length === 0) {
      options.push(`${modifier.name}: true`);
    } else if (modifier.name === "maxConcurrency" && args.length === 1) {
      options.push(`maxConcurrency: ${args[0]}`);
    } else if (modifier.name === "on" || modifier.name === "cancelOn") {
      hooks.push(modifier);
    } else {
      unreadable.push(`the task modifier ${modifier.name}(${args.join(", ")})`);
    }
  }

  return { root: call, fn, modifiers, options, hooks, unreadable };
}

/**
 * @param {string} source
 * @param {Node} fn a generator function, or a generator method's function
 * @param {string[]} options
 * @param {NestedEdits} edits
 * @param {string[]} unreadable
 * @param {string} taskName the local name of `task`
 * @returns {() => string} renders `task({ drop: true }, async () => {})`
 */
function modernTask(source, fn, options, edits, unreadable, taskName) {
  walk(fn.body, (node) => {
    if (
      node.type === "FunctionExpression" ||
      node.type === "FunctionDeclaration" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassBody"
    ) {
      return SKIP;
    }

    if (node.type === "Identifier" && node.name === "arguments") {
      unreadable.push("a task reads `arguments`, which an arrow function does not have");
    }

    if (node.type !== "YieldExpression") return;

    if (node.delegate || !node.argument) {
      unreadable.push(`\`${source.slice(node.start, node.end)}\` in a task`);
      return;
    }

    let argument = node.argument;

    edits.replace(node, () => {
      let text = edits.print(argument);

      return SIMPLE.has(argument.type) ? `await ${text}` : `await (${text})`;
    });
  });

  return () => {
    let params = fn.params.map((/** @type {Node} */ param) => edits.print(param)).join(", ");
    let async = `async (${params}) => ${edits.print(fn.body)}`;

    return options.length > 0
      ? `${taskName}({ ${options.join(", ")} }, ${async})`
      : `${taskName}(${async})`;
  };
}

/**
 * The expressions that `await x` reads the same as `yield x`. Others, such as `a + b`, need parentheses.
 */
const SIMPLE = new Set([
  "CallExpression",
  "MemberExpression",
  "Identifier",
  "Literal",
  "NewExpression",
  "ThisExpression",
  "ArrayExpression",
  "ObjectExpression",
  "TemplateLiteral",
  "ParenthesizedExpression",
]);

/**
 * @param {string} source
 * @param {Node | undefined} node the options of a task decorator, such as `{ maxConcurrency: 3 }`
 * @param {string[]} unreadable
 * @returns {string[]}
 */
function decoratorOptions(source, node, unreadable) {
  if (!node) return [];

  if (node.type !== "ObjectExpression") {
    unreadable.push(`the task options ${source.slice(node.start, node.end)}`);
    return [];
  }

  return node.properties.map((/** @type {Node} */ property) =>
    source.slice(property.start, property.end),
  );
}

/**
 * Rewrites the tasks of native classes to the syntax of ember-concurrency 5:
 * `name = task({ drop: true }, async () => {})`, with `await` for each `yield`.
 * It reads `@task *name() {}`, the decorators such as `@dropTask`, `@(task(function* () {}).drop()) name;`,
 * and `name = task(function* () {}).drop();`.
 *
 * @param {string} source
 * @param {string} file
 * @returns {{ source: string, unreadable: string[] }}
 */
export function modernizeTasks(source, file) {
  let program = parseProgram(source, file);

  if (!program) return { source, unreadable: [`${file} does not parse`] };

  let names = taskImports(program);

  if (names.size === 0) return { source, unreadable: [] };

  let edits = new NestedEdits(source);
  /** @type {string[]} */
  let unreadable = [];
  let taskName =
    Array.from(importMap(program)).find(
      ([, value]) => value.module === "ember-concurrency" && value.imported === "task",
    )?.[0] ?? "task";
  let print = (/** @type {Node} */ node) => source.slice(node.start, node.end);

  walk(program, (node) => {
    if (node.type === "Property" && readLegacyTask(source, node.value, names)) {
      unreadable.push(`the task ${print(node.key)} in a classic class`);
      return;
    }

    if (node.type !== "PropertyDefinition" && node.type !== "MethodDefinition") return;

    let key = node.computed ? `[${print(node.key)}]` : print(node.key);
    let decorators = node.decorators ?? [];

    if (node.type === "PropertyDefinition") {
      let legacy = node.value
        ? readLegacyTask(source, node.value, names)
        : decorators.length === 1
          ? readLegacyTask(source, decorators[0].expression, names)
          : undefined;

      if (!legacy) return;

      if (node.value && decorators.length > 0) {
        unreadable.push(`the task ${key} has decorators`);
        return;
      }

      for (let hook of legacy.hooks) {
        unreadable.push(`the task ${key} runs on ${print(hook.node.callee.property)}(...)`);
      }

      for (let reason of legacy.unreadable) unreadable.push(reason);

      let render = modernTask(source, legacy.fn, legacy.options, edits, unreadable, taskName);
      let isStatic = node.static ? "static " : "";

      edits.replace(node, () => `${isStatic}${key} = ${render()};`);
      return SKIP;
    }

    let decorator = decorators.find((/** @type {Node} */ entry) => {
      let expression = entry.expression;
      let callee = expression.type === "CallExpression" ? expression.callee : expression;

      return callee.type === "Identifier" && names.has(callee.name);
    });

    if (!decorator) return;

    if (!node.value.generator) {
      unreadable.push(`the task ${key} is not a generator method`);
      return;
    }

    if (decorators.length > 1) {
      unreadable.push(`the task ${key} has other decorators`);
      return;
    }

    let expression = decorator.expression;
    let callee = expression.type === "CallExpression" ? expression.callee : expression;
    let flag = DECORATORS.get(/** @type {string} */ (names.get(callee.name)));
    let options = flag ? [`${flag}: true`] : [];

    if (expression.type === "CallExpression") {
      if (expression.arguments.length > 1) {
        unreadable.push(`the task ${key} has a decorator with several arguments`);
        return;
      }

      for (let option of decoratorOptions(source, expression.arguments[0], unreadable)) {
        options.push(option);
      }
    }

    let render = modernTask(source, node.value, options, edits, unreadable, taskName);

    edits.replace(node, () => `${key} = ${render()};`);
    return SKIP;
  });

  if (edits.size === 0 || unreadable.length > 0) return { source, unreadable };

  /**
   * The decorators that the tasks used are gone, and each task calls `task`.
   */
  let output = updateImports(edits.apply(), file, {
    prune: Array.from(MODULES),
    add: new Map([["ember-concurrency", new Set([taskName])]]),
  });

  return { source: output, unreadable };
}
