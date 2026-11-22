import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const TEMPLATES = /<template>([^]*?)<\/template>/g;
const TEXT_LITERAL = /`([^`$\\]*\n[^`$\\]*)`/g;

/**
 * @param {string} contents a template's contents
 * @returns {number} the indentation that content-tag removes: the smallest of the lines that are not blank
 */
export function commonIndent(contents) {
  let indents = contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => /^ */.exec(line)?.[0].length ?? 0);

  return indents.length > 0 ? indents.reduce((a, b) => Math.min(a, b)) : 0;
}

/**
 * @param {string} line
 * @returns {string} the text that the line renders, without tags and mustaches
 */
function renderedText(line) {
  return line
    .replace(/<[^>]*>/g, "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .trim();
}

/**
 * @param {Project} project
 * @returns {Map<string, Set<number>>} for each template line, by its indentation and text, the indentation that content-tag removes
 */
export function templateLines(project) {
  /** @type {Map<string, Set<number>>} */
  let lines = new Map();

  for (let file of project.files(["app/**/*.{gjs,gts}"])) {
    for (let match of project.read(file).matchAll(TEMPLATES)) {
      let contents = String(match[1]);
      let indent = commonIndent(contents);

      if (indent === 0) continue;

      for (let line of contents.split("\n")) {
        let text = renderedText(line);

        if (!text) continue;

        let key = `${/^ */.exec(line)?.[0].length}|${text}`;

        lines.set(key, (lines.get(key) ?? new Set()).add(indent));
      }
    }
  }

  return lines;
}

/**
 * Moves the lines of a test's string literal by the indentation that content-tag removes from the
 * template that renders them. A line that matches no template line, or templates with different
 * indentation, stays as it is.
 *
 * @param {string} source a test file
 * @param {Map<string, Set<number>>} lines
 * @returns {string}
 */
export function dedentExpectations(source, lines) {
  return source.replace(TEXT_LITERAL, (literal, body) => {
    let all = String(body).split("\n");
    let changed = all.slice(1).map((line) => {
      let indent = /^ */.exec(line)?.[0].length ?? 0;
      let found = lines.get(`${indent}|${line.trim()}`);

      if (!found || found.size !== 1) return line;

      let [dedent] = found;

      return line.slice(Math.min(indent, Number(dedent)));
    });

    return `\`${[all[0]].concat(changed).join("\n")}\``;
  });
}

/**
 * content-tag, which @embroider/vite builds `<template>` with, removes the indentation that all
 * lines of a template share. Text that spans lines renders with less whitespace than before,
 * so a test that compares it with a string that has the old whitespace fails, although the app did not change.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "template-whitespace",
  label: "Match the tests' expected text to the whitespace that content-tag renders",

  detect(project) {
    let lines = templateLines(project);

    return project
      .files(["tests/**/*.{js,ts,gjs,gts}"])
      .some((file) => dedentExpectations(project.read(file), lines) !== project.read(file));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let lines = templateLines(project);
    /** @type {string[]} */
    let changed = [];

    for (let file of project.files(["tests/**/*.{js,ts,gjs,gts}"])) {
      let source = project.read(file);
      let output = dedentExpectations(source, lines);

      if (output !== source) {
        project.write(file, output);
        changed.push(file);
      }
    }

    recordProgress(project, {
      id: "template-whitespace",
      status: "changed",
      note:
        `content-tag removes the indentation that all lines of a <template> share, so ${changed.join(", ")} ` +
        "expect less whitespace in text that spans lines now. Only the expected strings changed.",
    });

    return [];
  },
};
