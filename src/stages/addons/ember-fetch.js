import { parseProgram, walk } from "#ast.js";
import { removeBuildOptions } from "#config-files.js";
import { Edits } from "#edits.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('#types.js').Finding} Finding */

/**
 * The app, its tests, and in-repo addons and engines.
 */
const SOURCES = [
  "{app,addon,addon-test-support,tests,src}/**/*.{js,ts,gjs,gts}",
  "lib/*/{addon,app,addon-test-support}/**/*.{js,ts,gjs,gts}",
];

/**
 * The bodies of the helpers in `ember-fetch/errors`.
 *
 * @type {Record<string, string>}
 */
const ERROR_HELPERS = {
  isUnauthorizedResponse: "(response) => response.status === 401",
  isForbiddenResponse: "(response) => response.status === 403",
  isInvalidResponse: "(response) => response.status === 422",
  isBadRequestResponse: "(response) => response.status === 400",
  isNotFoundResponse: "(response) => response.status === 404",
  isGoneResponse: "(response) => response.status === 410",
  isAbortError: "(error) => error.name === 'AbortError'",
  isConflictResponse: "(response) => response.status === 409",
  isServerErrorResponse: "(response) => response.status >= 500 && response.status < 600",
};

/**
 * Browsers and Node have fetch and its classes as globals.
 */
const GLOBALS = new Set(["default", "Headers", "Request", "Response", "AbortController"]);

/**
 * Removes ember-fetch, and uses the global `fetch` (RFC 1065).
 * ember-vite-codemod refuses an app with ember-fetch.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ember-fetch",
  label: "Replace ember-fetch with the global fetch (RFC 1065)",

  detect(project) {
    return Boolean(project.dependency("ember-fetch"));
  },

  async check(project) {
    return { blockers: [], todo: leftovers(project) };
  },

  async run(project) {
    let todo = leftovers(project);

    let waits = false;

    for (let file of project.files(SOURCES)) {
      let source = project.read(file);

      if (!/['"](fetch|ember-fetch\/errors)['"]/.test(source)) continue;

      let output = transform(source, file);

      if (output !== source) project.write(file, output);
      if (output.includes("waitForFetch")) waits = true;
    }

    editPackageJson(project, (pkg) => {
      removeDependency(pkg, "ember-fetch");

      if (
        waits &&
        !pkg.dependencies?.["@ember/test-waiters"] &&
        !pkg.devDependencies?.["@ember/test-waiters"]
      ) {
        setDependency(
          pkg,
          "@ember/test-waiters",
          `^${published("@ember/test-waiters")?.version ?? "4.1.2"}`,
        );
      }
    });
    removeBuildOptions(project, ["ember-fetch"]);

    recordProgress(project, {
      id: "ember-fetch",
      status: "removed",
      note:
        "ember-fetch is removed, and the code uses the global fetch, through waitForFetch of @ember/test-waiters, so that tests wait for each request. " +
        "ember-fetch rejected some responses that fetch resolves, so check the error handling of each call.",
      links: ["https://rfcs.emberjs.com/id/1065-remove-ember-fetch"],
    });

    return todo;
  },
};

/**
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
export function transform(source, file) {
  let program = parseProgram(source, file);

  if (!program) return source;

  let edits = new Edits(source);

  for (let node of /** @type {Node[]} */ (program.body)) {
    if (node.type !== "ImportDeclaration") continue;

    if (node.source.value === "fetch") {
      /** @type {string[]} */
      let aliases = [];
      let handled = node.specifiers.every((/** @type {Node} */ specifier) => {
        let imported =
          specifier.type === "ImportDefaultSpecifier" ? "default" : specifier.imported?.name;

        if (!GLOBALS.has(imported)) return false;

        let global = imported === "default" ? "fetch" : imported;

        /**
         * ember-fetch told the test helpers to wait for each request. waitForFetch does that for the global fetch.
         */
        if (imported === "default") {
          let typed = /\.g?ts$/.test(file)
            ? "input: RequestInfo | URL, init?: RequestInit"
            : "input, init";

          aliases.push(
            `import { waitForFetch } from '@ember/test-waiters';\nconst ${specifier.local.name} = (${typed}) => waitForFetch(globalThis.fetch(input, init));`,
          );
        } else if (specifier.local.name !== global) {
          aliases.push(`const ${specifier.local.name} = ${global};`);
        }

        return true;
      });

      if (!handled) continue;

      if (aliases.length > 0) edits.replace(node, aliases.join("\n"));
      else edits.removeLine(node);
    }

    if (node.source.value === "ember-fetch/errors") {
      let helpers = node.specifiers.map((/** @type {Node} */ specifier) => {
        let body = ERROR_HELPERS[specifier.imported?.name];

        if (body && /\.g?ts$/.test(file)) {
          body = body
            .replace("(response)", "(response: Response)")
            .replace("(error)", "(error: DOMException)");
        }

        return body ? `const ${specifier.local.name} = ${body};` : undefined;
      });

      if (helpers.every(Boolean)) edits.replace(node, helpers.join("\n"));
    }
  }

  return edits.size > 0 ? edits.apply() : source;
}

/**
 * Imports that the stage does not change.
 *
 * @param {import('#project.js').Project} project
 * @returns {Finding[]}
 */
function leftovers(project) {
  /** @type {string[]} */
  let where = [];

  for (let file of project.files(SOURCES)) {
    let source = project.read(file);

    if (!/['"](fetch|ember-fetch)(\/[^'"]*)?['"]/.test(source)) continue;

    let program = parseProgram(source, file);

    walk(program, (node) => {
      if (node.type !== "ImportDeclaration") return;

      let value = node.source.value;
      let known =
        (value === "fetch" &&
          node.specifiers.every((/** @type {Node} */ s) =>
            GLOBALS.has(s.type === "ImportDefaultSpecifier" ? "default" : s.imported?.name),
          )) ||
        (value === "ember-fetch/errors" &&
          node.specifiers.every((/** @type {Node} */ s) => s.imported?.name in ERROR_HELPERS));

      if ((value === "fetch" || value.startsWith("ember-fetch")) && !known) {
        where.push(`${file}: import from "${value}"`);
      }
    });
  }

  return where.length > 0
    ? [
        {
          title: "Imports from ember-fetch that have no global",
          where,
          action:
            "Use the global fetch. For the ember-data adapter mixin, see https://rfcs.emberjs.com/id/1065-remove-ember-fetch.",
        },
      ]
    : [];
}
