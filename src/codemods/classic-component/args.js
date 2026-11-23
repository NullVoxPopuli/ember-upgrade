/** @typedef {import('./read.js').ClassicComponent} ClassicComponent */
/** @typedef {import('./read.js').Member} Member */

/**
 * The keys of a classic component that are not its arguments or its own state.
 * The Glimmer version gives each one a replacement, or the conversion stops.
 */
export const COMPONENT_API = new Set([
  "$",
  "_super",
  "args",
  "attrs",
  "element",
  "elementId",
  "isDestroyed",
  "isDestroying",
  "constructor",
]);

/**
 * @typedef {object} Names
 * @property {Set<string>} args the keys that come from the caller, as `this.args.x` and `@x`
 * @property {Map<string, string>} defaults the arguments that have a default, and its source
 * @property {Map<string, string>} callbacks the arguments that the component sets, and the callback argument that it calls instead
 * @property {Set<string>} tracked the keys that become `@tracked` state
 * @property {Set<string>} declared the tracked keys that the class does not declare yet
 * @property {Set<string>} conflicts the keys that a caller passes, but the class defines as a method or getter
 * @property {boolean} getters each argument gets a getter, because the component passes itself to others, which read its properties
 */

/**
 * @typedef {object} NameUsage
 * @property {Set<string>} passed the keys that callers pass
 * @property {Set<string>} reads the keys that the class and template read
 * @property {Set<string>} writes the keys that the class and template set
 * @property {Set<string>} templateReads the keys that the template reads
 * @property {Map<string, import('./usage.js').Usage>} members the keys that each member reads and sets
 * @property {boolean} [open] callers can get the component from `(component "name")`, so the arguments that they pass are unknown
 * @property {boolean} [leaks] the component passes itself to others
 */

/**
 * @param {string} name such as `value` or `on-change`
 * @returns {string} such as `onValueChange`
 */
export function callbackName(name) {
  let pascal = name
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");

  return `on${pascal}Change`;
}

/**
 * @param {Member} member
 * @returns {boolean} a field without a decorator, such as `isOpen = false`
 */
function plainField(member) {
  return member.kind === "field" && member.decorators.length === 0;
}

/**
 * Decides which keys of a classic component are arguments, which are state, and which arguments it sets.
 *
 * A key that a caller passes is an argument. When the class also defines it, its value is the default.
 * A key that the class reads, but does not define or set, is an argument too, because classic
 * components get every argument as a property, and a caller can pass it through a dynamic invocation.
 * A key that the class or template sets, but no caller passes, is the component's own state.
 * State is `@tracked` when the template reads it, or a member that does not set it.
 *
 * @param {ClassicComponent} component
 * @param {NameUsage} usage
 * @returns {Names}
 */
export function classifyNames(component, usage) {
  /** @type {Names} */
  let names = {
    args: new Set(),
    defaults: new Map(),
    callbacks: new Map(),
    tracked: new Set(),
    declared: new Set(),
    conflicts: new Set(),
    getters: usage.leaks === true,
  };
  let reactive = (/** @type {string} */ name) =>
    usage.templateReads.has(name) ||
    Array.from(usage.members.values()).some(
      (member) => member.reads.has(name) && !member.writes.has(name),
    );
  let members = new Map(component.members.map((member) => [member.name, member]));
  let passed = new Set(usage.passed);

  for (let name of component.positionalParams) passed.add(name);

  for (let [name, member] of members) {
    let written = usage.writes.has(name);

    if (!passed.has(name) && !(usage.open && plainField(member) && !written)) {
      if (plainField(member) && written && reactive(name)) names.tracked.add(name);
      continue;
    }

    if (plainField(member)) {
      names.args.add(name);

      let value = member.value;

      if (value !== undefined && value !== "null" && value !== "undefined") {
        names.defaults.set(name, value);
      }
    } else if (member.kind === "method" && /^[^{]*\{\s*\}$/.test(member.source)) {
      names.args.add(name);
      names.defaults.set(name, "() => {}");
    } else {
      names.conflicts.add(name);
    }
  }

  let keys = new Set(usage.reads);

  for (let name of passed) keys.add(name);

  for (let name of keys) {
    if (members.has(name) || COMPONENT_API.has(name)) continue;

    if (passed.has(name) || !usage.writes.has(name)) {
      names.args.add(name);
    } else {
      if (reactive(name)) names.tracked.add(name);
      names.declared.add(name);
    }
  }

  for (let name of names.args) {
    if (usage.writes.has(name)) names.callbacks.set(name, callbackName(name));
  }

  return names;
}
