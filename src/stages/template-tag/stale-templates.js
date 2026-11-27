import { rmSync } from "node:fs";
import { join } from "node:path";

/** @typedef {import('#project.js').Project} Project */

const TEMPLATES = ["app/**/*.hbs"];

/**
 * A component in a .gjs or .gts file with its own `<template>` does not use an .hbs file of the same name.
 * The codemod stops at a component with both, so the .hbs file goes.
 *
 * @param {Project} project
 * @returns {string[]} the .hbs files that are removed
 */
export function removeStaleTemplates(project) {
  /** @type {string[]} */
  let removed = [];

  for (let file of project.files(TEMPLATES)) {
    let base = file.slice(0, -".hbs".length);
    let module = [`${base}.gjs`, `${base}.gts`].find((candidate) => project.has(candidate));

    if (!module || !project.read(module).includes("<template>")) continue;

    rmSync(join(project.directory, file));
    removed.push(file);
  }

  return removed;
}
