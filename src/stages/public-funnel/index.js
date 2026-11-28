import { rmSync } from "node:fs";
import { join } from "node:path";

import { parseProgram, propertyName } from "#ast.js";
import { addVitePlugin, viteConfig } from "#config-files.js";
import { editPackageJson } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#ast.js').Node} Node */

const HOOKS = new Set(["name", "isDevelopingAddon", "treeForPublic"]);

/**
 * @typedef {object} PublicFunnel
 * @property {string} folder the folder that the Funnel reads, from the project root
 * @property {string[]} include
 * @property {string[]} exclude
 * @property {string} destDir
 */

/**
 * @param {Node | undefined} node
 * @returns {string[] | undefined} the strings of an array literal
 */
function strings(node) {
  if (node?.type !== "ArrayExpression") return;

  let values = node.elements.map((/** @type {Node} */ element) =>
    element?.type === "Literal" && typeof element.value === "string" ? element.value : undefined,
  );

  return values.every((/** @type {string | undefined} */ value) => value !== undefined)
    ? /** @type {string[]} */ (values)
    : undefined;
}

/**
 * An in-repo addon whose only build hook copies a folder into the public tree with broccoli-funnel.
 *
 * @param {string} source the addon's index.js
 * @param {string} file
 * @returns {PublicFunnel | undefined} undefined when the addon does anything else
 */
export function publicFunnel(source, file) {
  let program = parseProgram(source, file);

  if (!program) return;

  /** @type {string | undefined} */
  let funnel;
  /** @type {Node | undefined} */
  let object;

  for (let statement of program.body) {
    if (statement.type === "ExpressionStatement" && statement.directive) continue;

    let declarator =
      statement.type === "VariableDeclaration" ? statement.declarations[0] : undefined;
    let init = declarator?.init;

    if (
      init?.type === "CallExpression" &&
      init.callee.name === "require" &&
      init.arguments[0]?.value === "broccoli-funnel" &&
      declarator.id.type === "Identifier"
    ) {
      funnel = declarator.id.name;
      continue;
    }

    let expression = statement.type === "ExpressionStatement" ? statement.expression : undefined;

    if (
      expression?.type === "AssignmentExpression" &&
      expression.left.type === "MemberExpression" &&
      expression.left.object.name === "module" &&
      expression.left.property.name === "exports" &&
      expression.right.type === "ObjectExpression"
    ) {
      object = expression.right;
      continue;
    }

    return;
  }

  if (!funnel || !object) return;

  let names = object.properties.map((/** @type {Node} */ property) => propertyName(property));

  if (
    !names.every((/** @type {string | undefined} */ name) => name && HOOKS.has(name)) ||
    !names.includes("treeForPublic")
  )
    return;

  let hook = object.properties.find(
    (/** @type {Node} */ property) => propertyName(property) === "treeForPublic",
  );
  let body = hook?.value?.body?.body ?? [];
  let returned =
    body.length === 1 && body[0].type === "ReturnStatement" ? body[0].argument : undefined;

  if (
    returned?.type !== "NewExpression" ||
    returned.callee.name !== funnel ||
    returned.arguments[0]?.type !== "Literal" ||
    typeof returned.arguments[0].value !== "string"
  ) {
    return;
  }

  let options = returned.arguments[1];
  /** @type {PublicFunnel} */
  let result = { folder: returned.arguments[0].value, include: [], exclude: [], destDir: "" };

  if (options && options.type !== "ObjectExpression") return;

  for (let property of options?.properties ?? []) {
    let name = propertyName(property);

    if (name === "include" || name === "exclude") {
      let values = strings(property.value);

      if (!values) return;

      result[name] = values;
    } else if (
      name === "destDir" &&
      property.value.type === "Literal" &&
      typeof property.value.value === "string"
    ) {
      result.destDir = property.value.value.replace(/^\/|\/$/g, "");
    } else {
      return;
    }
  }

  return result;
}

/**
 * @param {PublicFunnel} funnel
 * @param {string} name the plugin's name
 * @returns {string} a Vite plugin that serves the files in dev, and copies them into the build
 */
export function pluginSource(funnel, name) {
  return `import { cpSync, createReadStream, existsSync, globSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, matchesGlob, resolve } from 'node:path';

/**
 * The files that the in-repo addon ${name} put in the public folder with broccoli-funnel.
 */
const SOURCE = resolve(import.meta.dirname, '..', ${JSON.stringify(funnel.folder)});
const INCLUDE = ${JSON.stringify(funnel.include.length > 0 ? funnel.include : ["**/*"])};
const EXCLUDE = ${JSON.stringify(funnel.exclude)};
const DEST = ${JSON.stringify(funnel.destDir)};

function copied(path) {
  return INCLUDE.some((glob) => matchesGlob(path, glob)) && !EXCLUDE.some((glob) => matchesGlob(path, glob));
}

export default {
  name: ${JSON.stringify(name)},
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      let url = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
      let path = DEST ? url.slice(DEST.length + 1) : url;
      let file = join(SOURCE, path);

      if ((DEST && !url.startsWith(\`\${DEST}/\`)) || !copied(path) || !existsSync(file) || statSync(file).isDirectory()) {
        return next();
      }

      if (file.endsWith('.json')) response.setHeader('content-type', 'application/json');

      createReadStream(file).pipe(response);
    });
  },
  writeBundle(options) {
    for (let path of globSync(INCLUDE, { cwd: SOURCE })) {
      let from = join(SOURCE, path);

      if (!copied(path) || statSync(from).isDirectory()) continue;

      let to = join(options.dir, DEST, path);

      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
    }
  },
};
`;
}

/**
 * @param {Project} project
 * @returns {{ path: string, name: string, funnel: PublicFunnel }[]} the in-repo addons that only copy a folder into the public tree
 */
function funnelAddons(project) {
  /** @type {string[]} */
  let paths =
    /** @type {{ paths?: string[] }} */ (project.packageJson["ember-addon"] ?? {}).paths ?? [];
  /** @type {{ path: string, name: string, funnel: PublicFunnel }[]} */
  let found = [];

  for (let path of paths) {
    let file = `${path}/index.js`;
    let funnel = project.has(file) ? publicFunnel(project.read(file), file) : undefined;

    if (funnel) found.push({ path, name: path.split("/").pop() ?? path, funnel });
  }

  return found;
}

/**
 * @param {string} name such as `api-docs-data`
 * @returns {string} such as `apiDocsData`
 */
function camelCase(name) {
  return name.replace(/[-_.]+(\w)/g, (_, letter) => letter.toUpperCase());
}

/**
 * ember-cli merged the public trees of in-repo addons into the build. Vite builds without in-repo addons,
 * so a plugin in vite/ serves and copies the same files.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "public-funnel",
  label: "Copy the public files of a broccoli-funnel in-repo addon with a Vite plugin",

  detect(project) {
    return Boolean(viteConfig(project)) && funnelAddons(project).length > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    /** @type {import('#types.js').Finding[]} */
    let todo = [];

    for (let addon of funnelAddons(project)) {
      let file = `vite/${addon.name}.mjs`;
      let local = camelCase(addon.name);

      project.write(file, pluginSource(addon.funnel, addon.name));

      let added = addVitePlugin(project, {
        importLine: `import ${local} from './${file}';`,
        call: local,
        specifier: `./${file}`,
      });

      if (!added) {
        todo.push({
          title: `Add the plugin of ${file} to the Vite config`,
          where: [viteConfig(project) ?? "vite.config.mjs"],
          action: "Import its default export, and add it to `plugins`.",
        });
      }

      editPackageJson(project, (pkg) => {
        let paths = pkg["ember-addon"].paths.filter(
          (/** @type {string} */ path) => path !== addon.path,
        );

        if (paths.length > 0) pkg["ember-addon"].paths = paths;
        else delete pkg["ember-addon"].paths;

        if (Object.keys(pkg["ember-addon"]).length === 0) delete pkg["ember-addon"];
      });

      rmSync(join(project.directory, addon.path), { recursive: true, force: true });

      recordProgress(project, {
        id: `${addon.path}: public-funnel`,
        status: "moved",
        note:
          `The in-repo addon ${addon.path} copied ${addon.funnel.folder} into the public folder with broccoli-funnel. ` +
          `${file} serves the same files in dev, and copies them into the build.`,
      });
    }

    return todo;
  },
};
