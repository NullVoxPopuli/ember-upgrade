import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { parseProgram, walk } from "#ast.js";
import { Edits } from "#edits.js";

/** @typedef {import('#ast.js').Node} Node */

/**
 * @typedef {object} Injection
 * @property {string} type such as `route`, or `route:application` for one class
 * @property {string} property such as `session`
 * @property {string} service such as `session`
 */

/**
 * @param {string} source an initializer
 * @param {string} file
 * @returns {{ injections: Injection[], source: string }} the `application.inject()` calls, and the source without them
 */
export function readInjections(source, file) {
  let program = parseProgram(source, file);
  /** @type {Injection[]} */
  let injections = [];

  if (!program) return { injections, source };

  let edits = new Edits(source);

  walk(program, (node) => {
    let call = node.type === "ExpressionStatement" ? node.expression : undefined;
    let callee = call?.type === "CallExpression" ? call.callee : undefined;

    if (
      callee?.type !== "MemberExpression" ||
      callee.computed ||
      callee.property.name !== "inject"
    ) {
      return;
    }

    let [type, property, service] = call.arguments.map((/** @type {Node} */ arg) =>
      arg.type === "Literal" && typeof arg.value === "string" ? arg.value : undefined,
    );

    if (call.arguments.length !== 3 || !type || !property || !service?.startsWith("service:")) {
      return;
    }

    injections.push({ type, property, service: service.slice("service:".length) });
    edits.removeLine(node);
  });

  return { injections, source: edits.size > 0 ? edits.apply() : source };
}

/**
 * @param {string} source a class module
 * @param {string} file
 * @param {Injection} injection
 * @param {boolean} [read] the class's template reads the property
 * @returns {string} the source with the service declared on its class, when the class reads the property and does not declare it
 */
export function declareService(source, file, injection, read = false) {
  let { property, service } = injection;

  if (!read && !new RegExp(`\\b${property}\\b`).test(source)) return source;

  let program = parseProgram(source, file);

  if (!program) return source;

  /** @type {string | undefined} */
  let local;
  let declared = false;

  for (let node of program.body) {
    if (node.type !== "ImportDeclaration" || node.source.value !== "@ember/service") continue;

    for (let specifier of node.specifiers) {
      let imported = specifier.imported?.name;

      if (imported === "service" || imported === "inject") local = specifier.local.name;
    }
  }

  /** @type {{ at: number, text: string } | undefined} */
  let insert;
  let name = local ?? "service";
  let argument = service === property ? "" : `'${service}'`;

  walk(program, (node) => {
    let key = node.key?.name ?? node.key?.value;
    let member =
      node.type === "PropertyDefinition" ||
      node.type === "Property" ||
      node.type === "MethodDefinition";

    if (member && key === property) declared = true;
  });

  walk(program, (node) => {
    if (insert) return;

    if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && node.superClass) {
      let decorator = argument ? `@${name}(${argument})` : `@${name}`;

      insert = { at: node.body.start + 1, text: `\n  ${decorator} ${property};\n` };
      return;
    }

    let callee = node.type === "CallExpression" ? node.callee : undefined;
    let object = node.arguments?.findLast(
      (/** @type {Node} */ arg) => arg.type === "ObjectExpression",
    );

    if (callee?.type === "MemberExpression" && callee.property?.name === "extend" && object) {
      insert = { at: object.start + 1, text: `\n  ${property}: ${name}(${argument}),` };
    }
  });

  if (declared || !insert) return source;

  let edits = new Edits(source);

  edits.insert(insert.at, insert.text);

  if (!local) {
    let lastImport = program.body.findLast(
      (/** @type {Node} */ node) => node.type === "ImportDeclaration",
    );

    edits.insert(
      lastImport ? lastImport.end : 0,
      `${lastImport ? "\n" : ""}import { service } from '@ember/service';${lastImport ? "" : "\n"}`,
    );
  }

  return edits.apply();
}

/**
 * Ember 4 removed implicit injections, such as `application.inject('route', 'session', 'service:session')`.
 * Each class of that type that reads the property declares the service now.
 *
 * @param {import('#project.js').Project} project
 * @returns {Injection[]} the injections that the stage moved
 */
export function explicitInjections(project) {
  /** @type {Injection[]} */
  let moved = [];

  /**
   * ember-data injected `store` into routes and controllers, until ember-data 4.
   */
  if (project.has("package.json") && project.dependency("ember-data")) {
    for (let type of ["route", "controller"]) {
      let injection = { type, property: "store", service: "store" };

      for (let target of project.files([`app/${type}s/**/*.{js,ts}`])) {
        let before = project.read(target);
        let after = declareService(before, target, injection);

        if (after !== before) project.write(target, after);
      }

      if (type === "controller") controllersForTemplates(project, injection, undefined);
    }
  }

  for (let file of project.files(["app/{initializers,instance-initializers}/**/*.{js,ts}"])) {
    let { injections, source } = readInjections(project.read(file), file);

    if (injections.length === 0) continue;

    project.write(file, source);

    for (let injection of injections) {
      let [type, name] = injection.type.split(":");
      let pattern = name ? `app/${type}s/${name}.{js,ts}` : `app/${type}s/**/*.{js,ts}`;

      for (let target of project.files([pattern])) {
        let before = project.read(target);
        let after = declareService(before, target, injection);

        if (after !== before) project.write(target, after);
      }

      if (type === "controller") controllersForTemplates(project, injection, name);

      moved.push(injection);
    }
  }

  return moved;
}

/**
 * A route template read the injected property from its controller, which can have no class of its own.
 *
 * @param {import('#project.js').Project} project
 * @param {Injection} injection
 * @param {string | undefined} only the one controller that the injection named
 */
function controllersForTemplates(project, injection, only) {
  let { property, service } = injection;
  let reads = new RegExp(`\\{\\{[^}]*\\b(this\\.)?${property}\\b`);

  for (let template of project.files(["app/templates/**/*.hbs"])) {
    let route = template.replace(/^app\/templates\//, "").replace(/\.hbs$/, "");

    if (route.startsWith("components/") || (only && route !== only)) continue;
    if (!reads.test(project.read(template))) continue;

    let existing = ["js", "ts"]
      .map((ext) => `app/controllers/${route}.${ext}`)
      .find((file) => project.has(file));

    if (existing) {
      let before = project.read(existing);
      let after = declareService(before, existing, injection, true);

      if (after !== before) project.write(existing, after);
      continue;
    }

    let className = route
      .split(/[/-]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
    let decorator = service === property ? "@service" : `@service('${service}')`;

    mkdirSync(join(project.directory, "app/controllers", route, ".."), { recursive: true });
    project.write(
      `app/controllers/${route}.js`,
      `import Controller from '@ember/controller';\nimport { service } from '@ember/service';\n\nexport default class ${className}Controller extends Controller {\n  ${decorator} ${property};\n}\n`,
    );
  }
}

const TRANSITIONS = [
  { files: "app/routes/**/*.{js,ts}", from: /\bthis\.(transitionTo|replaceWith)\(/g },
  { files: "app/controllers/**/*.{js,ts}", from: /\bthis\.(transitionToRoute|replaceRoute)\(/g },
];

/**
 * Ember 5 removed the transition methods of routes and controllers. The router service has them.
 *
 * @param {import('#project.js').Project} project
 */
export function routerServiceTransitions(project) {
  let injection = { type: "", property: "router", service: "router" };

  for (let { files, from } of TRANSITIONS) {
    for (let file of project.files([files])) {
      let source = project.read(file);
      /**
       * A route's own transitionTo in a hook replaced the transition, so code aborted the old one first.
       * After an abort, the test helpers' visit() rejects, even though the router service starts the new one.
       */
      let withoutAbort = file.startsWith("app/routes/")
        ? source.replace(
            /^[ \t]*\w+\.abort\(\);[ \t]*\n(?=\s*(?:return\s+)?this\.(?:transitionTo|replaceWith)\()/gm,
            "",
          )
        : source;
      let output = withoutAbort.replace(from, (_, method) => {
        let name =
          method === "transitionToRoute"
            ? "transitionTo"
            : method === "replaceRoute"
              ? "replaceWith"
              : method;

        return `this.router.${name}(`;
      });

      if (output === source) continue;

      project.write(file, declareService(output, file, injection, true));
    }
  }
}
