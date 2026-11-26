import { parseProgram, walk } from "#ast.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('#types.js').Finding} Finding */

const ADDONS = ["ember-cli-document-title", "ember-cli-document-title-northm"];

/**
 * @param {string} source
 * @param {Node} node an expression of the route's `model` parameter, such as `model.addon.get('name')`
 * @param {string} model the parameter's name
 * @returns {string | undefined} the same value as a template path, such as `@model.addon.name`
 */
export function templatePath(source, node, model) {
  if (node.type === "Identifier") return node.name === model ? "@model" : undefined;

  if (node.type === "MemberExpression" && !node.computed) {
    let object = templatePath(source, node.object, model);

    return object && `${object}.${node.property.name}`;
  }

  let callee = node.type === "CallExpression" ? node.callee : undefined;
  let key = node.arguments?.[0];

  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.name === "get" &&
    node.arguments.length === 1 &&
    key?.type === "Literal" &&
    typeof key.value === "string"
  ) {
    let object = templatePath(source, callee.object, model);

    return object && `${object}.${key.value}`;
  }
}

/**
 * @param {string} source
 * @param {Node} fn the `titleToken` function
 * @returns {string | undefined} the argument of `page-title` that gives the same token
 */
function titleArgument(source, fn) {
  let body = fn.body?.body;
  let returned =
    body?.length === 1 && body[0].type === "ReturnStatement" ? body[0].argument : undefined;

  if (returned?.type === "Literal" && typeof returned.value === "string") {
    return JSON.stringify(returned.value);
  }

  let model = fn.params[0]?.type === "Identifier" ? fn.params[0].name : undefined;

  return returned && model ? templatePath(source, returned, model) : undefined;
}

/**
 * @param {string} source
 * @param {string} file
 * @returns {{ argument?: string, title?: string, titleFunction?: string, member?: Node, unreadable?: string }}
 */
export function readRouteTitle(source, file) {
  let program = parseProgram(source, file);

  if (!program) return {};

  /** @type {{ argument?: string, title?: string, titleFunction?: string, member?: Node, unreadable?: string }} */
  let found = {};

  walk(program, (node) => {
    if (
      node.type !== "MethodDefinition" &&
      node.type !== "Property" &&
      node.type !== "PropertyDefinition"
    ) {
      return;
    }

    let key = node.computed ? undefined : node.key;
    let name = key?.type === "Identifier" ? key.name : key?.value;

    if (name !== "titleToken" && !(name === "title" && /\/application\.[jt]s$/.test(file))) return;

    let value = node.value;

    if (name === "title") {
      /**
       * The application route's `title(tokens)` joins the tokens. ember-page-title joins them with its separator.
       */
      /** @type {string[]} */
      let strings = [];

      walk(value, (child) => {
        if (child.type === "Literal" && typeof child.value === "string") strings.push(child.value);
      });

      /**
       * The function itself moves, when it uses only its tokens, so the title keeps its format.
       */
      let fn =
        value?.type === "FunctionExpression" || value?.type === "ArrowFunctionExpression"
          ? value
          : undefined;
      let usesThis = false;

      walk(fn?.body, (child) => {
        if (child.type === "ThisExpression") usesThis = true;
      });

      let movable = fn && fn.params.length === 1 && fn.params[0].type === "Identifier" && !usesThis;

      found = {
        member: node,
        title: strings.at(-1),
        titleFunction: movable
          ? `function title(${fn.params[0].name}) ${source.slice(fn.body.start, fn.body.end)}`
          : undefined,
      };
      return;
    }

    let argument =
      value?.type === "Literal" && typeof value.value === "string"
        ? JSON.stringify(value.value)
        : value?.type === "FunctionExpression" || value?.type === "ArrowFunctionExpression"
          ? titleArgument(source, value)
          : undefined;

    found = argument
      ? { member: node, argument }
      : { unreadable: source.slice(node.start, node.end).split("\n")[0] };
  });

  return found;
}

/**
 * @param {string} source
 * @param {Node} member
 * @returns {string} the source without the member's lines, and without the blank line that separated it
 */
function withoutMember(source, member) {
  let start = source.lastIndexOf("\n", member.start - 1) + 1;
  let end = source.indexOf("\n", member.end) + 1;

  if (source.slice(end).startsWith("\n")) {
    end += 1;
  } else if (source.slice(0, start).endsWith("\n\n")) {
    start -= 1;
  }

  return source.slice(0, start) + source.slice(end);
}

/**
 * @param {string} titleFunction the application route's `title(tokens)`, as a function declaration
 * @returns {string} a page-title service that builds the title with it, from the route templates' titles
 */
export function pageTitleService(titleFunction) {
  return `import PageTitleService from 'ember-page-title/services/page-title';

/**
 * ember-cli-document-title built the title with the application route's title(tokens),
 * from each route's titleToken, outermost first. The route templates give those titles now.
 */
export default class PageTitle extends PageTitleService {
  toString() {
    return title(this.visibleTokens.map((token) => token.title).filter(Boolean));
  }
}

${titleFunction.replace(/^ {2}/gm, "")}
`;
}

/**
 * @param {import('#project.js').Project} project
 */
function plan(project) {
  /** @type {{ route: string, template: string, member: Node, call?: string }[]} */
  let changes = [];
  /** @type {string | undefined} */
  let titleFunction;
  /** @type {Finding[]} */
  let blockers = [];

  for (let route of project.files(["app/routes/**/*.{js,ts}"])) {
    let source = project.read(route);

    if (!/\btitle(Token)?\b/.test(source)) continue;

    let found = readRouteTitle(source, route);

    if (found.unreadable) {
      blockers.push({
        title: `A titleToken that the stage cannot write as a page-title call: ${found.unreadable}`,
        where: [route],
        action: "Write a `{{page-title}}` call in the route's template, and remove titleToken.",
      });
      continue;
    }

    if (!found.member) continue;

    let name = route.replace(/^app\/routes\//, "").replace(/\.(js|ts)$/, "");
    let call =
      found.titleFunction !== undefined
        ? undefined
        : found.title !== undefined
          ? `{{page-title ${JSON.stringify(found.title)}}}`
          : `{{page-title ${found.argument}}}`;

    titleFunction ??= found.titleFunction;
    changes.push({ route, template: `app/templates/${name}.hbs`, member: found.member, call });
  }

  return { changes, blockers, titleFunction };
}

/**
 * ember-cli-document-title set the title from each route's `titleToken`, and ember.nvp apps load no v1 addons.
 * ember-page-title sets it from `{{page-title}}` calls in the route templates.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "document-title",
  label: "Move the route titles of ember-cli-document-title to ember-page-title",

  detect(project) {
    return ADDONS.some((name) => project.dependency(name));
  },

  async check(project) {
    return { blockers: plan(project).blockers, todo: [] };
  },

  async run(project) {
    let { changes, titleFunction } = plan(project);

    for (let { route, template, member, call } of changes) {
      let source = project.read(route);

      project.write(route, withoutMember(source, member));

      if (!call) continue;

      let existing = project.has(template) ? project.read(template) : "{{outlet}}\n";

      project.write(template, `${call}\n${existing}`);
    }

    if (titleFunction && !project.has("app/services/page-title.js")) {
      project.write("app/services/page-title.js", pageTitleService(titleFunction));
    }

    editPackageJson(project, (pkg) => {
      for (let name of ADDONS) removeDependency(pkg, name);

      if (!pkg.dependencies?.["ember-page-title"] && !pkg.devDependencies?.["ember-page-title"]) {
        setDependency(
          pkg,
          "ember-page-title",
          `^${published("ember-page-title")?.version ?? "9.0.3"}`,
        );
      }
    });

    recordProgress(project, {
      id: "document-title",
      status: "removed",
      note:
        "ember-cli-document-title is removed. Each route's titleToken is a {{page-title}} call in its template now. " +
        'ember-page-title joins the titles with " | ", with the deepest route first. Check the title format of the application route.',
      links: ["https://github.com/ember-cli/ember-page-title"],
    });

    return [];
  },
};
