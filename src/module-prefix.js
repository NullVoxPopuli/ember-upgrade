import { parseProgram, propertyName, walk } from "#ast.js";

const ENVIRONMENT = "config/environment.js";

/**
 * @param {import('#project.js').Project} project
 * @returns {string} the name that the app's modules import each other by, such as `my-app` in `my-app/utils/x`
 */
export function modulePrefix(project) {
  let environment = project.has(ENVIRONMENT) ? project.read(ENVIRONMENT) : "";
  let program = environment ? parseProgram(environment, ENVIRONMENT) : undefined;
  /** @type {string | undefined} */
  let prefix;

  walk(program, (node) => {
    if (propertyName(node) === "modulePrefix" && node.value.type === "Literal")
      prefix ??= node.value.value;
  });

  return prefix ?? String(project.packageJson.name);
}
