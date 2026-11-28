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

export const FASTBOOT_CONFIG = "config/fastboot.js";

/**
 * The globals that FastBoot's sandbox needs for the global `fetch`. ember-fetch brought its own.
 */
const SANDBOX_GLOBALS = ["fetch", "Request", "Response", "Headers", "AbortController"];

const DEFAULT_FASTBOOT_CONFIG = `module.exports = function () {
  return {
    buildSandboxGlobals(defaultGlobals) {
      return Object.assign({}, defaultGlobals, {
        ${SANDBOX_GLOBALS.join(",\n        ")},
      });
    },
  };
};
`;

/**
 * FastBoot runs the app in a sandbox with only the globals of config/fastboot.js.
 *
 * @param {string} source config/fastboot.js
 * @param {string[]} [names] the globals that the sandbox needs
 * @returns {string | undefined} the source with the globals in the object of `buildSandboxGlobals`;
 * undefined when the file has no `Object.assign({}, defaultGlobals, { ... })` there
 */
export function withSandboxGlobals(source, names = SANDBOX_GLOBALS) {
  let program = parseProgram(source, FASTBOOT_CONFIG);
  /** @type {Node | undefined} */
  let globals;

  walk(program, (node) => {
    let name =
      node.type === "Property" || node.type === "MethodDefinition" ? node.key?.name : undefined;

    if (globals || name !== "buildSandboxGlobals") return;

    walk(node.value, (inner) => {
      let last = inner.arguments?.[inner.arguments.length - 1];

      if (
        !globals &&
        inner.type === "CallExpression" &&
        inner.callee.type === "MemberExpression" &&
        inner.callee.object.name === "Object" &&
        inner.callee.property.name === "assign" &&
        last?.type === "ObjectExpression"
      ) {
        globals = last;
      }
    });
  });

  if (!globals) return;

  let object = /** @type {Node} */ (globals);
  let present = new Set(
    object.properties.map(
      (/** @type {Node} */ property) => property.key?.name ?? property.key?.value,
    ),
  );
  let missing = names.filter((name) => !present.has(name));

  if (missing.length === 0) return source;

  let edits = new Edits(source);
  let indent =
    /\n([ \t]*)\S[^\n]*\n[ \t]*\}$/.exec(source.slice(object.start, object.end))?.[1] ?? "  ";
  let lastProperty = object.properties[object.properties.length - 1];
  let added = missing.map((name) => `\n${indent}${name},`).join("");

  if (!lastProperty) {
    edits.insert(object.start + 1, `${added}\n`);
    return edits.apply();
  }

  let after = source.slice(lastProperty.end, object.end);
  let comma = after.trimStart().startsWith(",");

  edits.insert(
    comma ? lastProperty.end + after.indexOf(",") + 1 : lastProperty.end,
    comma ? added : `,${added}`,
  );

  return edits.apply();
}

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

    if (project.dependency("ember-cli-fastboot")) {
      let config = project.has(FASTBOOT_CONFIG) ? project.read(FASTBOOT_CONFIG) : undefined;
      let output = config === undefined ? DEFAULT_FASTBOOT_CONFIG : withSandboxGlobals(config);

      if (output === undefined) {
        todo.push({
          title: "Give FastBoot's sandbox the globals of fetch",
          where: [FASTBOOT_CONFIG],
          action: `Add ${SANDBOX_GLOBALS.join(", ")} to the globals that buildSandboxGlobals returns.`,
        });
      } else if (output !== config) {
        project.write(FASTBOOT_CONFIG, output);
      }
    }

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
