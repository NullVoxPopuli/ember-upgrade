import { rmSync } from "node:fs";
import { join } from "node:path";

import { parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";
import { removePatches } from "#manager-settings.js";
import { editPackageJson, removeDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#ast.js').Node} Node */

/**
 * The packages that run only in FastBoot.
 */
const PACKAGES = ["ember-cli-fastboot", "ember-cli-fastboot-testing", "ember-data-fastboot"];
const CONFIGS = ["config/fastboot.js", "config/fastboot-testing.js"];
const SOURCES = ["{app,tests}/**/*.{js,ts,gjs,gts}"];

/**
 * @param {Node} node
 * @returns {boolean} the node is `this.fastboot.isFastBoot`
 */
function isFastBootCheck(node) {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.name === "isFastBoot" &&
    node.object.type === "MemberExpression" &&
    !node.object.computed &&
    node.object.object.type === "ThisExpression" &&
    node.object.property.name === "fastboot"
  );
}

/**
 * @param {string} source
 * @param {number} offset
 * @returns {{ start: number, end: number } | undefined} the `// @ts-expect-error` comment on the line above the offset
 */
function typeComment(source, offset) {
  let lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  let previousStart = source.lastIndexOf("\n", lineStart - 2) + 1;
  let previous = source.slice(previousStart, lineStart - 1);

  if (!previous.trim().startsWith("// @ts-expect-error")) return;

  return { start: previousStart + previous.indexOf("//"), end: lineStart - 1 };
}

/**
 * @param {string} source
 * @param {Node} node
 * @returns {{ start: number, end: number }} the node with the `//` comment lines right above it
 */
function withCommentsAbove(source, node) {
  let start = node.start;

  for (;;) {
    let lineStart = source.lastIndexOf("\n", start - 1) + 1;
    let previousStart = source.lastIndexOf("\n", lineStart - 2) + 1;

    if (lineStart === 0 || !source.slice(previousStart, lineStart).trim().startsWith("//")) break;

    start = previousStart + source.slice(previousStart, lineStart).indexOf("//");
  }

  return { start, end: node.end };
}

/**
 * Replaces `this.fastboot.isFastBoot` with `import.meta.env.SSR`, which is false in the browser build and true in a server build.
 * A statement that reads the service in another way, such as `this.fastboot.response.statusCode = 404`, ran only in FastBoot, so it goes.
 * The `fastboot` service goes when nothing else reads it.
 *
 * @param {string} source
 * @param {string} file
 * @returns {{ output: string, remaining: boolean, removed: string[] }} remaining is true when the code reads the service in another way,
 * and removed has the statements that ran only in FastBoot
 */
export function withoutFastBootService(source, file) {
  let program = parseProgram(source, file);

  if (!program || !source.includes("fastboot")) {
    return { output: source, remaining: false, removed: [] };
  }

  let edits = new Edits(source);
  /** @type {Node[]} */
  let checks = [];
  /** @type {Node[]} */
  let others = [];
  /** @type {Node[]} */
  let statements = [];
  /** @type {Node | undefined} */
  let declaration;

  walk(program, (node) => {
    if (node.type === "ExpressionStatement") statements.push(node);

    if (isFastBootCheck(node)) {
      checks.push(node);
      return;
    }

    if (
      node.type === "MemberExpression" &&
      !node.computed &&
      node.object.type === "ThisExpression" &&
      node.property.name === "fastboot" &&
      !checks.some((check) => check.object === node)
    ) {
      others.push(node);
    }

    if (
      (node.type === "PropertyDefinition" || node.type === "ClassProperty") &&
      node.key?.name === "fastboot" &&
      (node.decorators ?? []).some((/** @type {Node} */ decorator) =>
        source.slice(decorator.start, decorator.end).startsWith("@service"),
      )
    ) {
      declaration = node;
    }
  });

  /**
   * The innermost statement around each other read. Only a statement of its own, such as `this.fastboot.x = y;`, goes.
   */
  let around = others.map(
    (node) =>
      statements
        .filter((statement) => statement.start <= node.start && node.end <= statement.end)
        .sort((a, b) => b.start - a.start)[0],
  );
  let removable = around.every(
    (statement) =>
      statement && source.slice(statement.start, statement.end).startsWith("this.fastboot"),
  );
  let removedStatements = removable ? Array.from(new Set(around)) : [];

  if (checks.length === 0 && removedStatements.length === 0) {
    return { output: source, remaining: others.length > 0, removed: [] };
  }

  for (let check of checks) {
    let comment = typeComment(source, check.start);

    if (comment) edits.removeLine(comment);

    edits.replace(check, "import.meta.env.SSR");
  }

  for (let statement of removedStatements) edits.removeLine(withCommentsAbove(source, statement));

  let remaining = others.length > 0 && !removable;

  if (!remaining && declaration) edits.removeLine(declaration);

  let output = edits.apply();

  return {
    output: declaration && !remaining ? withoutUnusedServiceImport(output, file) : output,
    remaining,
    removed: removedStatements.map((statement) =>
      source.slice(statement.start, statement.end).replace(/\s+/g, " "),
    ),
  };
}

/**
 * @param {string} source
 * @param {string} file
 * @returns {string} the source without the specifiers of @ember/service that nothing reads anymore
 */
function withoutUnusedServiceImport(source, file) {
  let program = parseProgram(source, file);
  let declaration = program?.body.find(
    (/** @type {Node} */ node) =>
      node.type === "ImportDeclaration" && node.source.value === "@ember/service",
  );

  if (!declaration) return source;

  let rest = source.slice(0, declaration.start) + source.slice(declaration.end);
  let unused = declaration.specifiers.filter(
    (/** @type {Node} */ specifier) => !new RegExp(`\\b${specifier.local.name}\\b`).test(rest),
  );

  if (unused.length === 0) return source;

  let edits = new Edits(source);
  let kept = declaration.specifiers.filter(
    (/** @type {Node} */ specifier) => !unused.includes(specifier),
  );

  if (kept.length === 0) {
    edits.removeLine(declaration);
  } else {
    let names = kept.map((/** @type {Node} */ specifier) =>
      source.slice(specifier.start, specifier.end),
    );
    let quote = source[declaration.source.start];
    let typeOnly = declaration.importKind === "type" ? "type " : "";

    edits.replace(
      declaration,
      `import ${typeOnly}{ ${names.join(", ")} } from ${quote}@ember/service${quote};`,
    );
  }

  return edits.apply();
}

/**
 * FastBoot renders with the ember-cli build, which Vite replaces, and Embroider stops on what ember-cli-fastboot adds to the app.
 * Server rendering is the work of vite-ember-ssr, after the ember-nvp stage.
 *
 * @param {Project} project
 * @returns {import('#types.js').Finding[]}
 */
export function removeFastBoot(project) {
  /** @type {import('#types.js').Finding[]} */
  let todo = [];

  if (!PACKAGES.some((name) => project.dependency(name))) return todo;

  /** @type {string[]} */
  let remaining = [];
  /** @type {string[]} */
  let removed = [];

  for (let file of project.files(SOURCES)) {
    let source = project.read(file);
    let result = withoutFastBootService(source, file);

    if (result.output !== source) project.write(file, result.output);
    if (result.remaining) remaining.push(file);

    for (let statement of result.removed) removed.push(`${file}: ${statement}`);
  }

  editPackageJson(project, (pkg) => {
    for (let name of PACKAGES) removeDependency(pkg, name);

    delete pkg.fastbootDependencies;
  });

  for (let name of PACKAGES) removePatches(project, name);
  for (let file of CONFIGS) rmSync(join(project.directory, file), { force: true });

  if (remaining.length > 0) {
    todo.push({
      title: "Code that reads the fastboot service for more than isFastBoot",
      where: remaining,
      action:
        "It ran only in FastBoot, which the Vite build does not have. Move it to the server rendering of vite-ember-ssr, or remove it.",
    });
  }

  recordProgress(project, {
    id: "ember-cli-fastboot",
    status: "removed",
    note:
      "FastBoot renders with the ember-cli build, which Vite replaces, so ember-cli-fastboot and its addons are removed. " +
      "`this.fastboot.isFastBoot` is `import.meta.env.SSR` now. Prerender or render on the server with vite-ember-ssr." +
      (removed.length > 0
        ? ` These statements ran only in FastBoot, and are removed: ${removed.join("; ")}.`
        : ""),
    links: ["https://github.com/evoactivity/vite-ember-ssr"],
  });

  return todo;
}
