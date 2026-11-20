/**
 * @typedef {Record<string, any>} Manifest
 */

const SECTIONS = ["dependencies", "devDependencies"];

/**
 * Changes package.json, and keeps its indentation and its final newline.
 *
 * @param {import('#project.js').Project} project
 * @param {(pkg: Manifest) => void} change
 */
export function editPackageJson(project, change) {
  let source = project.read("package.json");
  let indent = source.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
  let pkg = JSON.parse(source);

  change(pkg);

  project.write(
    "package.json",
    JSON.stringify(pkg, null, indent) + (source.endsWith("\n") ? "\n" : ""),
  );
}

/**
 * @param {Manifest} pkg
 * @param {string} name
 * @returns {boolean} true when the package was a dependency
 */
export function removeDependency(pkg, name) {
  let found = false;

  for (let section of SECTIONS) {
    if (pkg[section] && name in pkg[section]) {
      delete pkg[section][name];
      found = true;
    }
  }

  return found;
}

/**
 * Sets the range in the section that has the package now.
 * A new package goes in devDependencies, because apps bundle all their dependencies.
 *
 * @param {Manifest} pkg
 * @param {string} name
 * @param {string} range
 */
export function setDependency(pkg, name, range) {
  let section = SECTIONS.find((key) => pkg[key] && name in pkg[key]) ?? "devDependencies";

  pkg[section] = sorted(Object.assign({}, pkg[section], { [name]: range }));
}

/**
 * @param {Manifest} pkg
 * @returns {string[]} the names in dependencies and devDependencies
 */
export function dependencyNames(pkg) {
  return Object.keys(Object.assign({}, pkg.devDependencies, pkg.dependencies));
}

/**
 * pnpm 10 builds a git-hosted package only when the project allows it.
 *
 * @param {Manifest} pkg
 * @param {string} name
 */
export function allowBuild(pkg, name) {
  pkg.pnpm ??= {};

  let allowed = pkg.pnpm.onlyBuiltDependencies ?? [];

  if (!allowed.includes(name)) pkg.pnpm.onlyBuiltDependencies = allowed.concat(name).sort();
}

/**
 * @param {Record<string, string>} object
 */
function sorted(object) {
  /** @type {Record<string, string>} */
  let result = {};

  for (let key of Object.keys(object).sort()) result[key] = object[key];

  return result;
}
