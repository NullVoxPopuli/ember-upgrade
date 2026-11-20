import { parseProgram, propertyName, walk } from "#ast.js";
import { removeProperty } from "#config-files.js";
import { Edits } from "#edits.js";
import { editPackageJson, setDependency } from "#package-json.js";
import { atLeast } from "#version.js";

/** @typedef {import('#ast.js').Node} Node */
/** @typedef {import('#types.js').Finding} Finding */

const ENVIRONMENT = "config/environment.js";
const ROUTES = ["js", "ts", "gjs", "gts"].map((extension) => `app/routes/application.${extension}`);
const UPGRADING = "https://github.com/adopted-ember-addons/ember-metrics/blob/main/UPGRADING.md";

/**
 * @param {string} name such as "GoogleAnalyticsFour"
 */
function dasherize(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * @param {string} text
 * @param {string} indent
 * @returns {string} the text, with its first line as it is and the other lines moved to `indent`
 */
function reindent(text, indent) {
  let lines = text.split("\n");
  let rest = lines.slice(1).filter((line) => line.trim() !== "");
  let least = Math.min.apply(
    null,
    rest.map((line) => line.match(/^ */)?.[0].length ?? 0),
  );

  if (!Number.isFinite(least)) return text;

  /**
   * The closing bracket has the least indentation, and goes to `indent`.
   */
  return [lines[0]]
    .concat(lines.slice(1).map((line) => (line.trim() === "" ? "" : indent + line.slice(least))))
    .join("\n");
}

/**
 * Copies the `metricsAdapters` array, and adds an `adapter` class to each entry.
 *
 * @param {import('#project.js').Project} project
 * @param {string} source config/environment.js
 * @param {Node} array
 * @param {string} routeFile where the copy goes
 * @param {string[]} imports receives the imports of the adapter classes
 * @returns {string | undefined} undefined when the array is not plain data
 */
function adaptersText(project, source, array, routeFile, imports) {
  let edits = new Edits(source);
  let plain = true;

  walk(array, (node, parent) => {
    let isKey = parent?.type === "Property" && parent.key === node && !parent.computed;

    if (!isKey && (node.type === "Identifier" || node.type === "ThisExpression")) plain = false;
  });

  if (!plain) return;

  for (let element of array.elements) {
    if (element?.type !== "ObjectExpression") return;

    let nameProperty = element.properties.find(
      (/** @type {Node} */ p) => propertyName(p) === "name",
    );
    let name = nameProperty?.value.type === "Literal" ? nameProperty.value.value : undefined;

    if (typeof name !== "string") return;

    let file = dasherize(name);
    let local = name.replace(/[^\w$]/g, "");
    let own = ["js", "ts"].some((extension) =>
      project.has(`app/metrics-adapters/${file}.${extension}`),
    );
    let from = own
      ? `${"../".repeat(routeFile.split("/").length - 2)}metrics-adapters/${file}`
      : `ember-metrics/metrics-adapters/${file}`;

    imports.push(`import ${local} from '${from}';`);

    let lineStart = source.lastIndexOf("\n", nameProperty.start - 1) + 1;
    let indent = source.slice(lineStart, nameProperty.start);
    let comma = source.slice(nameProperty.end).match(/^\s*,/);

    let separator = indent.trim() === "" ? `\n${indent}` : " ";

    edits.insert(
      nameProperty.end + (comma ? comma[0].length : 0),
      `${comma ? "" : ","}${separator}adapter: ${local},`,
    );
  }

  let output = edits.apply();

  return output.slice(array.start, array.end + output.length - source.length);
}

/**
 * @param {Node} program
 * @returns {string | undefined} the local name of the default import of config/environment
 */
function configImport(program) {
  for (let node of program.body) {
    if (
      node.type !== "ImportDeclaration" ||
      !/\/config\/environment(\.[jt]s)?$/.test(node.source.value)
    )
      continue;

    let specifier = node.specifiers.find(
      (/** @type {Node} */ s) => s.type === "ImportDefaultSpecifier",
    );

    if (specifier) return specifier.local.name;
  }
}

/**
 * @param {Node} program
 * @returns {Node | undefined} the class that the module exports by default
 */
function exportedClass(program) {
  let node = program.body.find((/** @type {Node} */ n) => n.type === "ExportDefaultDeclaration");

  if (
    node?.declaration.type === "ClassDeclaration" ||
    node?.declaration.type === "ClassExpression"
  ) {
    return node.declaration;
  }
}

/**
 * @param {Node} body the ClassBody
 * @returns {string | undefined} the property that holds the metrics service
 */
function metricsProperty(body) {
  for (let member of body.body) {
    if (member.type !== "PropertyDefinition" || !member.decorators?.length) continue;

    let decorator = member.decorators[0].expression;
    let argument = decorator.type === "CallExpression" ? decorator.arguments[0] : undefined;

    let key = member.computed ? undefined : member.key.name;

    if (argument?.type === "Literal" && argument.value === "metrics") return key;
    if (!argument && key === "metrics") return "metrics";
  }
}

/**
 * @param {Node} program
 * @returns {string | undefined} the local name of `service` from @ember/service
 */
function serviceImport(program) {
  for (let node of program.body) {
    if (node.type !== "ImportDeclaration" || node.source.value !== "@ember/service") continue;

    for (let specifier of node.specifiers) {
      let imported = specifier.imported?.name;

      if (imported === "service" || imported === "inject") return specifier.local.name;
    }
  }
}

/**
 * @param {string} prefix the modulePrefix of the app
 * @param {string[]} imports
 * @param {string} adapters
 */
function newRoute(prefix, imports, adapters) {
  return `import Route from '@ember/routing/route';
import { service } from '@ember/service';
import ENV from '${prefix}/config/environment';
${imports.join("\n")}

export default class ApplicationRoute extends Route {
  @service metrics;

  constructor() {
    super(...arguments);

    this.metrics.appEnvironment = ENV.environment;
    this.metrics.activateAdapters(${adapters});
  }
}
`;
}

/**
 * Adds the activation to an application route that exists.
 *
 * @param {string} source
 * @param {string} file
 * @param {string} prefix
 * @param {string[]} imports
 * @param {string} adapters
 * @returns {string | undefined} undefined when the route has a shape that this stage does not change
 */
function updateRoute(source, file, prefix, imports, adapters) {
  let program = parseProgram(source, file);
  let klass = program && exportedClass(program);

  if (!program || !klass) return;

  let edits = new Edits(source);
  let body = klass.body;
  let lines = imports.slice();
  let env = configImport(program);

  if (!env) {
    env = "ENV";
    lines.unshift(`import ENV from '${prefix}/config/environment';`);
  }

  let property = metricsProperty(body);
  let members = "";

  if (!property) {
    let service = serviceImport(program);

    if (!service) {
      service = "service";
      lines.unshift(`import { service } from '@ember/service';`);
    }

    property = "metrics";
    members += `\n  @${service} metrics;\n`;
  }

  let imported = program.body.filter((/** @type {Node} */ n) => n.type === "ImportDeclaration");
  let last = imported[imported.length - 1];

  edits.insert(last ? last.end : 0, last ? `\n${lines.join("\n")}` : `${lines.join("\n")}\n`);

  let activation =
    `this.${property}.appEnvironment = ${env}.environment;\n` +
    `    this.${property}.activateAdapters(${adapters});`;
  let constructor = body.body.find(
    (/** @type {Node} */ m) => m.type === "MethodDefinition" && m.kind === "constructor",
  );

  if (constructor) {
    let statements = constructor.value.body.body;
    let superCall = statements.find(
      (/** @type {Node} */ s) =>
        s.type === "ExpressionStatement" &&
        s.expression.type === "CallExpression" &&
        s.expression.callee.type === "Super",
    );

    if (!superCall) return;

    edits.insert(superCall.end, `\n\n    ${activation}`);
  } else {
    members += `\n  constructor() {\n    super(...arguments);\n\n    ${activation}\n  }\n`;
  }

  if (members) edits.insert(body.start + 1, members);

  return edits.apply();
}

/** @type {import('#types.js').Stage} */
export default {
  name: "ember-metrics",
  label: "Update ember-metrics to v3, and activate its adapters in the application route",

  detect(project) {
    let range = project.dependency("ember-metrics");

    return Boolean(range) && !atLeast(range, 3, 0);
  },

  async check(project) {
    /** @type {import('#types.js').Report} */
    let report = { blockers: [], todo: [] };
    let emberSource = project.dependency("ember-source");

    if (!atLeast(emberSource, 5, 8)) {
      report.blockers.push({
        title: `ember-metrics 3 needs ember-source 5.8 or newer, and the app has ${emberSource}`,
        where: ["package.json"],
        action: "Upgrade ember-source, then run ember-upgrade again.",
      });
    }

    return report;
  },

  async run(project) {
    /** @type {Finding[]} */
    let todo = [];

    editPackageJson(project, (pkg) => setDependency(pkg, "ember-metrics", "^3.0.0"));

    if (!project.has(ENVIRONMENT)) return todo;

    let source = project.read(ENVIRONMENT);
    let program = parseProgram(source, ENVIRONMENT);

    if (!program) return todo;

    /** @type {Node | undefined} */
    let adaptersProperty;
    /** @type {Node | undefined} */
    let settingsProperty;
    /** @type {string | undefined} */
    let prefix;

    walk(program, (node) => {
      let name = propertyName(node);

      if (name === "metricsAdapters" && node.value.type === "ArrayExpression")
        adaptersProperty ??= node;
      if (name === "ember-metrics") settingsProperty ??= node;
      if (name === "modulePrefix" && node.value.type === "Literal") prefix ??= node.value.value;
    });

    let routeFile = ROUTES.find((file) => project.has(file));
    let target = routeFile ?? ROUTES[0];
    /** @type {string[]} */
    let imports = [];
    let adapters =
      adaptersProperty && adaptersText(project, source, adaptersProperty.value, target, imports);
    let manual = {
      title: "Activate the ember-metrics adapters in the application route",
      where: [ENVIRONMENT, target],
      action: `ember-metrics 3 does not read metricsAdapters from config/environment.js. Follow ${UPGRADING}.`,
    };

    if (adaptersProperty && !adapters) {
      todo.push(manual);
      return todo;
    }

    if (adapters) {
      let text = reindent(adapters, "    ");
      let route = routeFile
        ? updateRoute(
            project.read(routeFile),
            routeFile,
            prefix ?? String(project.packageJson.name),
            imports,
            text,
          )
        : newRoute(prefix ?? String(project.packageJson.name), imports, text);

      if (!route) {
        todo.push(manual);
        return todo;
      }

      project.write(target, route);
    }

    let edits = new Edits(source);

    if (adaptersProperty) removeProperty(edits, adaptersProperty);
    if (settingsProperty) removeProperty(edits, settingsProperty);
    if (edits.size > 0) project.write(ENVIRONMENT, edits.apply());

    return todo;
  },
};
