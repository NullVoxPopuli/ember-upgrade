import { spawnSync } from "node:child_process";
import { relative } from "node:path";

import { parseProgram, propertyName, walk } from "#ast.js";
import { removeProperty } from "#config-files.js";
import { Edits } from "#edits.js";
import { exec } from "#process.js";
import { readProgress, recordProgress } from "#progress.js";

/** @typedef {import('#ast.js').Node} Node */

const PROGRESS_ID = "lint-baseline";

const TEMPLATE_LINT_CONFIGS = [
  ".template-lintrc.js",
  ".template-lintrc.cjs",
  ".template-lintrc.mjs",
];

const FLAT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
];

/**
 * ember-template-lint 4 removed `pending`, for the todo files of `--update-todo`,
 * and merged the `octane` preset into `recommended`.
 *
 * @param {string} source
 * @param {string} file
 * @returns {string | undefined} undefined when nothing changes
 */
export function modernTemplateLintConfig(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  let edits = new Edits(source);

  walk(program, (/** @type {Node} */ node) => {
    if (node.type !== "Property") return;

    let name = propertyName(node);

    if (name === "pending") removeProperty(edits, node);

    if (name !== "extends") return;

    let values = node.value.type === "ArrayExpression" ? node.value.elements : [node.value];

    for (let value of values) {
      if (value?.type === "Literal" && value.value === "octane") {
        edits.replace(value, source.slice(value.start, value.end).replace("octane", "recommended"));
      }
    }
  });

  return edits.size > 0 ? edits.apply() : undefined;
}

/**
 * Applies ESLint's fixes for unused disable directives.
 * ESLint puts a space where a comment was, so a line with only the comment would stay as a blank line.
 *
 * @param {string} source
 * @param {{ range: [number, number], text: string }[]} fixes
 * @returns {string}
 */
export function withoutDirectives(source, fixes) {
  let edits = new Edits(source);

  for (let { range, text } of fixes) {
    let [start, end] = range;

    if (text.trim() !== "") {
      edits.replace({ start, end }, text);
      continue;
    }

    let lineStart = source.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = source.indexOf("\n", end);
    let after = source.slice(end, lineEnd === -1 ? source.length : lineEnd);

    if (source.slice(lineStart, start).trim() === "" && after.trim() === "") {
      edits.removeLine({ start, end });
      continue;
    }

    while (start > lineStart && /[ \t]/.test(source[start - 1])) start--;

    edits.replace({ start, end }, "");
  }

  return edits.apply();
}

/**
 * @param {import('#project.js').Project} project
 * @returns {number} the files that changed
 */
function removeUnusedDirectives(project) {
  let result = spawnSync("npx", ["eslint", ".", "--format", "json"], {
    cwd: project.directory,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32",
  });

  /** @type {{ filePath: string, messages: { ruleId: string | null, message: string, fix?: { range: [number, number], text: string } }[] }[]} */
  let reports;

  try {
    reports = JSON.parse(result.stdout);
  } catch {
    return 0;
  }

  let changed = 0;

  for (let report of reports) {
    /** @type {{ range: [number, number], text: string }[]} */
    let fixes = [];

    for (let message of report.messages) {
      if (message.ruleId === null && message.fix && message.message.startsWith("Unused eslint-")) {
        fixes.push(message.fix);
      }
    }

    if (fixes.length === 0) continue;

    let file = relative(project.directory, report.filePath);

    project.write(file, withoutDirectives(project.read(file), fixes));
    changed++;
  }

  return changed;
}

/**
 * @param {import('#project.js').Project} project
 */
function hasEslint(project) {
  return Boolean(project.dependency("eslint")) && FLAT_CONFIGS.some((file) => project.has(file));
}

/**
 * @param {import('#project.js').Project} project
 */
function hasTemplateLint(project) {
  return Boolean(project.dependency("ember-template-lint"));
}

/** @type {import('#types.js').Stage} */
export default {
  name: "lint",
  label: "Record the lint errors that are left, so that lint passes from here on",
  needsInstall: true,

  detect(project) {
    if (readProgress(project).some((entry) => entry.id === PROGRESS_ID)) return false;

    return hasEslint(project) || hasTemplateLint(project);
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    for (let file of TEMPLATE_LINT_CONFIGS) {
      if (!project.has(file)) continue;

      let output = modernTemplateLintConfig(project.read(file), file);

      if (output) project.write(file, output);
    }

    /**
     * The new rule sets report errors in code that the upgrade did not write.
     * Each tool records them in a file, so that lint fails only for new errors.
     * The exit codes do not matter: a later lint run shows what is left.
     */
    if (hasEslint(project)) {
      /**
       * Without an unused eslint-disable, its eslint-enable is unused too.
       * ESLint's own --fix also runs again, up to 10 times.
       */
      for (let pass = 0; pass < 10 && removeUnusedDirectives(project) > 0; pass++);
      exec(project, "npx", ["eslint", ".", "--suppress-all"]);
    }

    if (hasTemplateLint(project)) {
      exec(project, "npx", ["ember-template-lint", ".", "--update-todo"]);
    }

    recordProgress(project, {
      id: PROGRESS_ID,
      status: "suppressed",
      note:
        "The lint errors from before the upgrade are in eslint-suppressions.json and .lint-todo. " +
        "Fix them, then remove the fixed ones with `eslint . --prune-suppressions` " +
        "and `ember-template-lint . --clean-todo`.",
      links: [
        "https://eslint.org/docs/latest/use/suppressions",
        "https://github.com/ember-template-lint/ember-template-lint/blob/main/docs/todos.md",
      ],
    });

    return [];
  },
};
