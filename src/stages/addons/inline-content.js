import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseProgram, propertyName, walk } from "#ast.js";
import { buildFile, removeBuildOptions } from "#config-files.js";
import { editPackageJson, removeDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#ast.js').Node} Node */

const HTML_FILES = ["index.html", "app/index.html", "tests/index.html"];

/**
 * A flag that the build reads with `true` as its default, such as `parseFlag('FAVICON', true)`.
 */
const ON_BY_DEFAULT = /^\w+\(\s*["'][\w-]+["']\s*,\s*true\s*\)$/;

/**
 * @typedef {object} Snippet
 * @property {string} key the `content-for` name, such as `snippets/favicon`
 * @property {string} file the file that ember-cli-inline-content inlined
 * @property {string | undefined} condition the test of the `if` around it
 */

/**
 * @param {string} source ember-cli-build
 * @param {string} file
 * @returns {Snippet[]}
 */
export function readSnippets(source, file) {
  let program = parseProgram(source, file);
  /** @type {Snippet[]} */
  let snippets = [];
  /** @type {Node[]} */
  let conditions = [];

  if (!program) return snippets;

  let text = (/** @type {Node} */ node) =>
    node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;

  walk(program, (node) => {
    if (node.type === "IfStatement" && !node.alternate) conditions.push(node);
  });

  /**
   * @param {Node} node
   * @returns {string | undefined}
   */
  let conditionOf = (node) => {
    let around = conditions.filter((entry) => entry.start < node.start && node.end <= entry.end);
    let inner = around.at(-1);

    return inner ? source.slice(inner.test.start, inner.test.end) : undefined;
  };

  walk(program, (node) => {
    if (node.type === "Property" && propertyName(node) === "inlineContent") {
      for (let entry of node.value.properties ?? []) {
        let key = propertyName(entry);
        let value = text(entry.value);

        if (key && value) snippets.push({ key, file: value, condition: conditionOf(node) });
      }
    }

    let left = node.type === "AssignmentExpression" ? node.left : undefined;

    if (left?.type !== "MemberExpression" || !left.computed) return;
    if (
      left.object?.type !== "MemberExpression" ||
      left.object.property?.name !== "inlineContent"
    ) {
      return;
    }

    let key = text(left.property);
    let value = text(node.right);

    if (key && value) snippets.push({ key, file: value, condition: conditionOf(node) });
  });

  return snippets;
}

/**
 * @param {string} file
 * @param {string} contents
 * @returns {string} the HTML that ember-cli-inline-content wrote for the file
 */
function snippetHtml(file, contents) {
  let trimmed = contents.trim();

  if (file.endsWith(".js")) return `<script>\n${trimmed}\n</script>`;
  if (file.endsWith(".css")) return `<style>\n${trimmed}\n</style>`;

  return trimmed;
}

/**
 * ember-cli-inline-content put files into index.html at `{{content-for}}` markers, and ember.nvp apps run no ember-cli build.
 * The HTML files hold the content now. A snippet behind a flag that is off by default, or that depends on the environment, goes to the progress file.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ember-cli-inline-content",
  label: "Move the snippets of ember-cli-inline-content into the HTML files",

  detect(project) {
    return Boolean(project.dependency("ember-cli-inline-content"));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let build = buildFile(project);
    let snippets = build ? readSnippets(project.read(build), build) : [];
    /** @type {Map<string, string>} */
    let left = new Map();

    for (let file of HTML_FILES.filter((name) => project.has(name))) {
      let html = project.read(file);

      for (let snippet of snippets) {
        let marker = new RegExp(
          `[ \\t]*\\{\\{content-for\\s+["']${snippet.key}["']\\s*\\}\\}[ \\t]*\\n?`,
          "g",
        );
        let included = !snippet.condition || ON_BY_DEFAULT.test(snippet.condition);
        let path = join(project.directory, snippet.file);
        let indent = /^([ \t]*)\{\{content-for/m.exec(html)?.[1] ?? "";

        html = html.replace(marker, () => {
          if (!included) return "";

          let content = snippetHtml(snippet.file, readFileSync(path, "utf8"));

          return `${content.replace(/^(?=.)/gm, indent)}\n`;
        });

        if (!included) {
          left.set(snippet.key, `${snippet.key} (${snippet.file}, if ${snippet.condition})`);
        }
      }

      project.write(file, html);
    }

    removeBuildOptions(project, ["inlineContent"]);
    editPackageJson(project, (pkg) => removeDependency(pkg, "ember-cli-inline-content"));

    if (left.size > 0) {
      recordProgress(project, {
        id: "ember-cli-inline-content",
        status: "removed",
        note:
          "The HTML files hold the snippets of ember-cli-inline-content now. These depended on a flag or the environment, so they are not in the HTML: " +
          `${Array.from(left.values()).join("; ")}. Add each one that you need, for example with a Vite plugin that uses transformIndexHtml.`,
        links: ["https://vite.dev/guide/api-plugin#transformindexhtml"],
      });
    }

    return [];
  },
};
