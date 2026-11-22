import { Edits } from "#edits.js";

/**
 * @typedef {{ start: number, end: number }} Range
 */

/**
 * Replacements whose text can hold other replacements.
 * Each replacement renders its text when the edits apply, so `print` of a child node
 * gives the child with its own replacements, such as `this.get('a')` inside `this.set('b', this.get('a'))`.
 */
export class NestedEdits {
  /** @type {{ node: Range, render: () => string }[]} */
  #found = [];

  /**
   * @param {string} source
   */
  constructor(source) {
    this.source = source;
  }

  get size() {
    return this.#found.length;
  }

  /**
   * @param {Range} node
   * @param {() => string} render
   */
  replace(node, render) {
    this.#found.push({ node, render });
  }

  /**
   * @param {Range} node
   * @returns {string} the node's source, with the replacements inside it
   */
  print(node) {
    let self = this.#found.find((entry) => entry.node === node);

    if (self) return self.render();

    let inside = outermost(
      this.#found.filter(
        (entry) =>
          entry.node !== node && node.start <= entry.node.start && entry.node.end <= node.end,
      ),
    ).sort((a, b) => a.node.start - b.node.start);
    let output = "";
    let offset = node.start;

    for (let entry of inside) {
      output += this.source.slice(offset, entry.node.start) + entry.render();
      offset = entry.node.end;
    }

    return output + this.source.slice(offset, node.end);
  }

  /**
   * @returns {string}
   */
  apply() {
    if (this.#found.length === 0) return this.source;

    let edits = new Edits(this.source);

    for (let entry of outermost(this.#found)) edits.replace(entry.node, entry.render());

    return edits.apply();
  }
}

/**
 * @template {{ node: Range }} T
 * @param {T[]} found
 * @returns {T[]} the entries that no other entry contains
 */
function outermost(found) {
  return found.filter(
    (entry) =>
      !found.some(
        (other) =>
          other !== entry &&
          other.node.start <= entry.node.start &&
          entry.node.end <= other.node.end,
      ),
  );
}
