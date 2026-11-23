import { Edits } from "#edits.js";
import { findInvocations, rangeOf } from "#codemods/classic-component/invocations.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * The arguments of the `click-outside` component that name its callback.
 */
const CALLBACKS = new Set(["action", "onClickOutside"]);

/**
 * ember-click-outside 4 removed the `click-outside` component, which wrapped its block in a `<div>`.
 * The `on-click-outside` modifier on a `<div>` does the same.
 *
 * @param {string} template
 * @returns {{ template: string, unreadable: string[] }}
 */
export function rewriteClickOutside(template) {
  let edits = new Edits(template);
  /** @type {string[]} */
  let unreadable = [];
  let text = (/** @type {Node} */ node) => {
    let range = rangeOf(node);

    return template.slice(range.start, range.end);
  };

  for (let invocation of findInvocations(template, "click-outside")) {
    let node = invocation.node;
    let range = rangeOf(node);
    /** @type {string[]} */
    let attributes = [];
    /** @type {string[]} */
    let options = [];
    let callback;
    let body;

    if (invocation.kind === "block") {
      for (let pair of node.hash.pairs) {
        let value =
          pair.value.type === "GlimmerPathExpression" ||
          pair.value.type === "GlimmerSubExpression" ||
          pair.value.type === "GlimmerStringLiteral"
            ? text(pair.value)
            : undefined;

        if (CALLBACKS.has(pair.key) && pair.value.type !== "GlimmerStringLiteral") callback = value;
        else if (pair.key === "class" && value) attributes.push(`class={{${value}}}`);
        else if (pair.key === "exceptSelector" && value) options.push(`exceptSelector=${value}`);
        else unreadable.push(`click-outside with ${pair.key}=`);
      }

      let open = template.indexOf("}}", range.start) + 2;
      let close = template.lastIndexOf("{{", range.end - 1);

      body = template.slice(open, close);
    } else if (invocation.kind === "angle") {
      for (let attribute of node.attributes) {
        let name = String(attribute.name);
        let value = attribute.value;
        let inner =
          value.type === "GlimmerMustacheStatement" ? text(value).slice(2, -2) : undefined;

        let literal = value.type === "GlimmerTextNode" ? JSON.stringify(value.chars) : undefined;

        if (CALLBACKS.has(name.slice(1)) && inner) callback = inner;
        else if (name === "@exceptSelector" && (inner ?? literal)) {
          options.push(`exceptSelector=${inner ?? literal}`);
        } else if (name.startsWith("@")) unreadable.push(`ClickOutside with ${name}`);
        else attributes.push(text(attribute));
      }

      if (node.selfClosing) {
        body = "";
      } else {
        let open = template.indexOf(">", rangeOf(node.attributes.at(-1) ?? node).end) + 1;
        let close = template.lastIndexOf("</", range.end - 1);

        body = template.slice(open, close);
      }
    } else {
      unreadable.push("click-outside without a block");
      continue;
    }

    if (!callback) {
      unreadable.push("click-outside without a callback");
      continue;
    }

    let modifier = `{{on-click-outside ${callback}${options.map((option) => ` ${option}`).join("")}}}`;
    let attributeText = attributes.map((attribute) => ` ${attribute}`).join("");

    edits.replace(range, `<div${attributeText} ${modifier}>${body}</div>`);
  }

  if (unreadable.length > 0) return { template, unreadable };

  return { template: edits.apply(), unreadable };
}
