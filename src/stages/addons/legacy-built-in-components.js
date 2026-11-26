import { rmSync } from "node:fs";
import { join } from "node:path";

import { parseProgram } from "#ast.js";
import { editPackageJson, removeDependency } from "#package-json.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#ast.js').Node} Node */

const ADDON = "@ember/legacy-built-in-components";
const SOURCES = ["{app,tests}/**/*.{js,ts,gjs,gts}"];
const APPLICATION_ROUTES = ["app/routes/application.js", "app/routes/application.ts"];
const SCROLL_TO_TOP = /^(if\(window\.scrollTo\)\{)?window\.scrollTo\(0,0\);?\}?$/;

export const APPLICATION_ROUTE = `import Route from '@ember/routing/route';
import { service } from '@ember/service';

export default class ApplicationRoute extends Route {
  @service router;

  constructor() {
    super(...arguments);

    this.router.on('routeDidChange', () => {
      window.scrollTo(0, 0);
    });
  }
}
`;

/**
 * @param {string} source
 * @param {string} file
 * @returns {boolean} the module is a subclass of the addon's LinkComponent that only scrolls to the top on a click
 */
export function isScrollOnlyLink(source, file) {
  let program = parseProgram(source, file);

  if (!program) return false;

  let imports = program.body.filter(
    (/** @type {Node} */ node) => node.type === "ImportDeclaration",
  );
  let addonImport = imports.find((/** @type {Node} */ node) => node.source.value === ADDON);
  let specifier = addonImport?.specifiers.find(
    (/** @type {Node} */ node) => node.imported?.name === "LinkComponent",
  );

  if (!specifier || imports.length !== 1 || addonImport.specifiers.length !== 1) return false;

  let declaration = program.body.find(
    (/** @type {Node} */ node) => node.type === "ExportDefaultDeclaration",
  )?.declaration;

  if (
    declaration?.type !== "ClassDeclaration" ||
    declaration.superClass?.name !== specifier.local.name ||
    program.body.length !== 2
  ) {
    return false;
  }

  let members = declaration.body.body;
  let click = members[0];

  if (members.length !== 1 || click.type !== "MethodDefinition" || click.key.name !== "click") {
    return false;
  }

  let body = click.value.body;

  return SCROLL_TO_TOP.test(source.slice(body.start + 1, body.end - 1).replace(/\s+/g, ""));
}

/**
 * @param {Project} project
 * @returns {{ links: string[], others: string[] }} the files that import the addon: subclasses that only scroll, and the rest
 */
function importers(project) {
  /** @type {string[]} */
  let links = [];
  /** @type {string[]} */
  let others = [];

  for (let file of project.files(SOURCES)) {
    let source = project.read(file);

    if (!source.includes(ADDON)) continue;

    if (isScrollOnlyLink(source, file)) links.push(file);
    else others.push(file);
  }

  return { links, others };
}

/**
 * The addon brings back the classic components that ember-source 4 removed, through private modules of Ember.
 * Its copy in the app does not build with ember-source 6, so the app's own uses of it change.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: ADDON,
  label: "Remove @ember/legacy-built-in-components, and scroll to the top on each route change",

  detect(project) {
    return Boolean(project.dependency(ADDON));
  },

  async check(project) {
    let { links, others } = importers(project);
    /** @type {import('#types.js').Finding[]} */
    let blockers = [];

    if (others.length > 0) {
      blockers.push({
        title: `Code that uses ${ADDON}`,
        where: others,
        action: "Use the built-in components of Ember, such as <LinkTo>, <Input> and <Textarea>.",
      });
    }

    let route = APPLICATION_ROUTES.find((file) => project.has(file));

    if (links.length > 0 && route) {
      blockers.push({
        title: "A LinkTo subclass that scrolls to the top, in an app with an application route",
        where: links.concat(route),
        action:
          "Scroll to the top in a `routeDidChange` listener of the router service, and delete the subclass.",
      });
    }

    return { blockers, todo: [] };
  },

  async run(project) {
    let { links } = importers(project);

    for (let file of links) rmSync(join(project.directory, file));

    if (links.length > 0) project.write("app/routes/application.js", APPLICATION_ROUTE);

    editPackageJson(project, (pkg) => removeDependency(pkg, ADDON));

    recordProgress(project, {
      id: ADDON,
      status: "removed",
      note:
        links.length > 0
          ? `${links.join(", ")} scrolled to the top on each click of a link. The application route scrolls to the top on each route change now, also for the back button.`
          : `The app did not import ${ADDON}.`,
    });

    return [];
  },
};
