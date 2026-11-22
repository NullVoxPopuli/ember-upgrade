/** @typedef {import('./read.js').ClassicComponent} ClassicComponent */

/**
 * The methods that the classic event dispatcher called with the DOM event of the component's element,
 * and the event that each one listens to.
 */
export const EVENTS = new Map([
  ["touchStart", "touchstart"],
  ["touchMove", "touchmove"],
  ["touchEnd", "touchend"],
  ["touchCancel", "touchcancel"],
  ["keyDown", "keydown"],
  ["keyUp", "keyup"],
  ["keyPress", "keypress"],
  ["mouseDown", "mousedown"],
  ["mouseUp", "mouseup"],
  ["contextMenu", "contextmenu"],
  ["click", "click"],
  ["doubleClick", "dblclick"],
  ["mouseMove", "mousemove"],
  ["mouseEnter", "mouseenter"],
  ["mouseLeave", "mouseleave"],
  ["focusIn", "focusin"],
  ["focusOut", "focusout"],
  ["submit", "submit"],
  ["change", "change"],
  ["input", "input"],
  ["dragStart", "dragstart"],
  ["drag", "drag"],
  ["dragEnter", "dragenter"],
  ["dragLeave", "dragleave"],
  ["dragOver", "dragover"],
  ["drop", "drop"],
  ["dragEnd", "dragend"],
]);

const VOID = new Set([
  "area",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const BOOLEAN_NAME = /^(is|has|should|can|show|hide|was|did|will)[A-Z]/;

/**
 * @param {string} name such as `isActive`
 * @returns {string} such as `is-active`
 */
function dasherize(name) {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

/**
 * @param {string} path such as `isActive` or `model.isActive`
 * @returns {string} the reference in the template
 */
function reference(path) {
  return `this.${path}`;
}

/**
 * @param {string} binding a `classNameBindings` entry, such as `isActive`, `isActive:active`, `isActive:on:off`, or `:static`
 * @param {ClassicComponent} component
 * @returns {string} the class, as template text
 */
export function classBinding(binding, component) {
  let [path = "", yes, no] = binding.split(":");

  if (!path) return String(yes);

  let value = reference(path);

  if (yes !== undefined) {
    return no !== undefined ? `{{if ${value} "${yes}" "${no}"}}` : `{{if ${value} "${yes}"}}`;
  }

  let property = path.split(".").pop() ?? path;
  let member = component.members.find((candidate) => candidate.name === path);
  let isBoolean =
    BOOLEAN_NAME.test(property) || member?.value === "true" || member?.value === "false";

  /**
   * ember-cli rendered a true value as the dasherized name, and a string as itself.
   * A property that reads as a boolean keeps the first behavior, and the others the second.
   */
  return isBoolean ? `{{if ${value} "${dasherize(property)}"}}` : `{{${value}}}`;
}

/**
 * @param {string} binding an `attributeBindings` entry, such as `disabled`, or `url:href` for a property and its attribute
 * @returns {string} the attribute, as template text
 */
export function attributeBinding(binding) {
  let [path = "", attribute = path] = binding.split(":");

  return `${attribute}={{${reference(path)}}}`;
}

/**
 * Writes the element that a classic component rendered around its template into the template,
 * as a Glimmer component needs. The element takes the caller's attributes with `...attributes`,
 * and the event methods of the class with `{{on}}`.
 *
 * @param {string} template the component's template
 * @param {ClassicComponent} component
 * @returns {{ template: string, events: string[] }} the new template, and the methods that handle events now
 */
export function writeOuterHtml(template, component) {
  let outer = component.outerHtml;
  let tag = outer.tagName ?? "div";
  let events = component.members
    .filter((member) => member.kind === "method" && EVENTS.has(member.name))
    .map((member) => member.name);

  if (tag === "") return { template, events: [] };

  /** @type {string[]} */
  let attributes = [];

  if (outer.elementId) attributes.push(`id="${outer.elementId}"`);
  if (outer.ariaRole) attributes.push(`role="${outer.ariaRole}"`);

  let classes = outer.classNames.concat(
    outer.classNameBindings.map((binding) => classBinding(binding, component)),
  );

  if (classes.length > 0) attributes.push(`class="${classes.join(" ")}"`);

  for (let binding of outer.attributeBindings) attributes.push(attributeBinding(binding));

  attributes.push("...attributes");

  for (let name of events) attributes.push(`{{on "${EVENTS.get(name)}" this.${name}}}`);

  let opening = `<${tag} ${attributes.join(" ")}`;

  if (VOID.has(tag) && template.trim() === "") return { template: `${opening} />\n`, events };

  /**
   * The body stays as it was, because indentation would change the whitespace of rendered text.
   */
  let body = template.endsWith("\n") ? template : `${template}\n`;

  return { template: `${opening}>\n${body}</${tag}>\n`, events };
}
