import { readClassicComponent } from "./read.js";
import { Edits } from "#edits.js";

/**
 * A classic component kept its actions apart from its properties, so `isDirty: false` and
 * `actions: { isDirty() {} }` both worked. A Glimmer component has one name for both.
 * Each such action gets a free name, in the module and in the component's own template,
 * before the conversion. A classic component with the new name does the same.
 *
 * @param {string} source the component module
 * @param {string} file
 * @param {string | undefined} template the component's template
 * @returns {{ source: string, template: string | undefined }}
 */
export function renameShadowedActions(source, file, template) {
  let component = readClassicComponent(source, file);

  if (!component) return { source, template };

  let names = new Set(component.members.map((member) => member.name));
  let fields = new Set(
    component.members
      .filter((member) => member.kind !== "method" && member.kind !== "actions")
      .map((member) => member.name),
  );
  let edits = new Edits(source);
  /** @type {Map<string, string>} */
  let renamed = new Map();

  for (let entry of component.members) {
    if (entry.kind !== "actions") continue;

    for (let property of entry.node.value.properties ?? []) {
      let key = property.key?.name ?? property.key?.value;

      if (typeof key !== "string" || !fields.has(key) || property.computed) continue;

      let name = `${key}Action`;

      for (let n = 2; names.has(name); n++) name = `${key}Action${n}`;

      names.add(name);
      renamed.set(key, name);
      edits.replace(property.key, name);
    }
  }

  if (renamed.size === 0) return { source, template };

  /**
   * @param {string} text
   * @param {RegExp} pattern its groups are the text before the name, the quote, and the name
   */
  let rename = (text, pattern) =>
    text.replace(pattern, (match, before, quote, key) =>
      renamed.has(key) ? `${before}${quote}${renamed.get(key)}${quote}` : match,
    );
  let sends = /(\.send\(\s*)(["'])([\w$]+)\2/g;
  let actions = /(\baction\s+)(["'])([\w$]+)\2/g;

  return {
    source: rename(edits.apply(), sends),
    template: template === undefined ? undefined : rename(template, actions),
  };
}
