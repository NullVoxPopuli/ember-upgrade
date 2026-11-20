/**
 * Changes to a source text, by offset.
 *
 * Codemods change the user's code, so the diff must hold only the change.
 * Printing a whole AST again reformats code that the codemod did not touch.
 * Offsets come from the original text, so the order of the calls does not matter.
 */
export class Edits {
  /** @type {{ start: number, end: number, text: string }[]} */
  #changes = [];

  /**
   * @param {string} source
   */
  constructor(source) {
    this.source = source;
  }

  get size() {
    return this.#changes.length;
  }

  /**
   * @param {{ start: number, end: number }} node
   * @param {string} text
   */
  replace(node, text) {
    this.#changes.push({ start: node.start, end: node.end, text });
  }

  /**
   * @param {number} offset
   * @param {string} text
   */
  insert(offset, text) {
    this.#changes.push({ start: offset, end: offset, text });
  }

  /**
   * Removes the node, and the rest of its line when nothing else is on it.
   *
   * @param {{ start: number, end: number }} node
   */
  removeLine(node) {
    let lineStart = this.source.lastIndexOf("\n", node.start - 1) + 1;
    let lineEnd = this.source.indexOf("\n", node.end);

    if (lineEnd === -1) lineEnd = this.source.length;

    let before = this.source.slice(lineStart, node.start);
    let after = this.source.slice(node.end, lineEnd);

    if (before.trim() === "" && after.trim() === "") {
      this.#changes.push({
        start: lineStart,
        end: Math.min(lineEnd + 1, this.source.length),
        text: "",
      });
    } else {
      this.#changes.push({ start: node.start, end: node.end, text: "" });
    }
  }

  /**
   * @returns {string}
   */
  apply() {
    let changes = this.#changes.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    let output = "";
    let offset = 0;

    for (let change of changes) {
      if (change.start < offset) {
        throw new Error(`Overlapping edits at offset ${change.start}`);
      }

      output += this.source.slice(offset, change.start) + change.text;
      offset = change.end;
    }

    return output + this.source.slice(offset);
  }
}
