import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

import { editPackageJson, setDependency, sorted } from "#package-json.js";
import { packageManager } from "#process.js";
import { Project } from "#project.js";

const WORKSPACE_FILE = "pnpm-workspace.yaml";

/**
 * The folder with the lockfile. In a monorepo, settings and overrides go there, not in the app.
 *
 * @param {Project} project
 * @returns {Project}
 */
export function workspaceRoot(project) {
  let lockfile = project.lockfile;

  return lockfile ? new Project(dirname(lockfile.path)) : project;
}

/**
 * @param {Project} project
 * @returns {number}
 */
export function pnpmMajor(project) {
  let root = workspaceRoot(project);
  let declared = root.has("package.json")
    ? String(root.packageJson.packageManager ?? "").match(/^pnpm@(\d+)/)
    : null;

  if (declared) return Number(declared[1]);

  let result = spawnSync("pnpm", ["--version"], {
    cwd: root.directory,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  return Number(result.stdout?.match(/^(\d+)/)?.[1] ?? 0);
}

/**
 * pnpm 10 reads settings from pnpm-workspace.yaml. pnpm 11 and later read them only from there.
 * Older versions read the `pnpm` field of package.json.
 *
 * @param {Project} project
 * @param {string} key such as "overrides"
 * @param {string} name
 * @param {string | boolean} value
 */
export function setPnpmMapSetting(project, key, name, value) {
  let root = workspaceRoot(project);

  if (pnpmMajor(project) < 10) {
    editPackageJson(root, (pkg) => {
      pkg.pnpm ??= {};
      pkg.pnpm[key] = Object.assign({}, pkg.pnpm[key], { [name]: value });
    });
    return;
  }

  let source = root.has(WORKSPACE_FILE) ? root.read(WORKSPACE_FILE) : "";

  root.write(WORKSPACE_FILE, setYamlMapEntry(source, key, name, value));
}

/**
 * pnpm 10 builds a dependency (git-hosted ones too) only when the project allows it.
 *
 * @param {Project} project
 * @param {string} name
 */
export function allowBuild(project, name) {
  let major = pnpmMajor(project);

  if (major >= 11) return setPnpmMapSetting(project, "allowBuilds", name, true);

  let root = workspaceRoot(project);

  if (major < 10) {
    editPackageJson(root, (pkg) => {
      pkg.pnpm ??= {};
      let allowed = pkg.pnpm.onlyBuiltDependencies ?? [];

      if (!allowed.includes(name)) pkg.pnpm.onlyBuiltDependencies = allowed.concat(name).sort();
    });
    return;
  }

  let source = root.has(WORKSPACE_FILE) ? root.read(WORKSPACE_FILE) : "";

  root.write(WORKSPACE_FILE, addYamlListEntry(source, "onlyBuiltDependencies", name));
}

/**
 * Forces one version of a package for the whole dependency tree.
 *
 * @param {Project} project
 * @param {string} name
 * @param {string} range
 */
export function addOverride(project, name, range) {
  let pm = packageManager(project);
  let root = workspaceRoot(project);

  /**
   * npm refuses an override that conflicts with a direct dependency.
   */
  editPackageJson(project, (pkg) => {
    if (["dependencies", "devDependencies"].some((key) => pkg[key] && name in pkg[key])) {
      setDependency(pkg, name, range);
    }
  });

  if (pm === "pnpm") return setPnpmMapSetting(project, "overrides", name, range);

  let field = pm === "yarn" ? "resolutions" : "overrides";

  editPackageJson(root, (pkg) => {
    pkg[field] = sorted(Object.assign({}, pkg[field], { [name]: range }));
  });
}

/**
 * Sets one entry two levels down, such as `packageExtensions` > `name@range` > `dependencies`.
 *
 * @param {string} source
 * @param {string} key
 * @param {string} name
 * @param {string} field
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function setYamlNestedMap(source, key, name, field, values) {
  let lines = [`  ${yamlScalar(name)}:`, `    ${field}:`].concat(
    Object.entries(values).map(([k, v]) => `      ${yamlScalar(k)}: ${yamlScalar(v)}`),
  );

  return editBlock(source, key, (entries) => {
    let start = entries.findIndex((entry) => /^ {2}\S/.test(entry) && entryName(entry) === name);

    if (start === -1) return entries.concat(lines);

    let end = start + 1;

    while (end < entries.length && !/^ {2}\S/.test(entries[end])) end++;

    return entries.slice(0, start).concat(lines, entries.slice(end));
  });
}

/**
 * Sets a top-level scalar, such as `strictDepBuilds: false`.
 *
 * @param {string} source
 * @param {string} key
 * @param {string | boolean} value
 * @returns {string}
 */
export function setYamlScalar(source, key, value) {
  let line = `${key}: ${typeof value === "boolean" ? value : yamlScalar(value)}`;
  let lines = source === "" ? [] : source.replace(/\n$/, "").split("\n");
  let index = lines.findIndex((entry) => entry.startsWith(`${key}:`));

  /**
   * A blank line separates the new key from a block, but not from another scalar.
   */
  let separator = lines.length > 0 && /^\s/.test(lines[lines.length - 1]) ? [""] : [];

  if (index === -1) return lines.concat(separator, line).join("\n") + "\n";

  return lines.map((entry, i) => (i === index ? line : entry)).join("\n") + "\n";
}

/**
 * Changes one entry of a top-level block map, and keeps the rest of the file as it is.
 *
 * @param {string} source
 * @param {string} key
 * @param {string} name
 * @param {string | boolean} value
 * @returns {string}
 */
export function setYamlMapEntry(source, key, name, value) {
  let line = `  ${yamlScalar(name)}: ${typeof value === "boolean" ? value : yamlScalar(value)}`;

  return editBlock(source, key, (entries) => {
    let index = entries.findIndex((entry) => entryName(entry) === name);

    if (index === -1) return entries.concat(line);

    return entries.map((entry, i) => (i === index ? line : entry));
  });
}

/**
 * @param {string} source
 * @param {string} key
 * @param {string} name
 * @returns {string}
 */
export function addYamlListEntry(source, key, name) {
  return editBlock(source, key, (entries) =>
    entries.some((entry) => entryName(entry) === name)
      ? entries
      : entries.concat(`  - ${yamlScalar(name)}`),
  );
}

/**
 * @param {string} source
 * @param {string} key
 * @param {(entries: string[]) => string[]} change gets the indented lines of the block
 */
function editBlock(source, key, change) {
  let lines = source === "" ? [] : source.replace(/\n$/, "").split("\n");
  let start = lines.findIndex((line) => line.startsWith(`${key}:`));

  if (start === -1) {
    let block = [`${key}:`].concat(change([]));
    let separator = lines.length > 0 ? [""] : [];

    return lines.concat(separator, block).join("\n") + "\n";
  }

  let end = start + 1;

  while (end < lines.length && (/^\s/.test(lines[end]) || lines[end] === "")) end++;

  /**
   * Keep the blank lines after the block outside of it.
   */
  while (end > start + 1 && lines[end - 1] === "") end--;

  let entries = lines.slice(start + 1, end);

  /**
   * An empty flow value, such as `overrides: {}`, becomes a block.
   */
  let head = /^[^:]+:\s*(\{\s*\}|\[\s*\])?\s*$/.test(lines[start]) ? `${key}:` : lines[start];

  return lines.slice(0, start).concat(head, change(entries), lines.slice(end)).join("\n") + "\n";
}

/**
 * @param {string} entry such as `  '@sentry/cli': false` or `  - esbuild`
 */
function entryName(entry) {
  let match = entry.match(/^\s+(?:-\s+)?(['"]?)(.+?)\1(?::\s|:$|$)/);

  return match?.[2];
}

/**
 * @param {string} value
 */
function yamlScalar(value) {
  return /^[\w.-]+$/.test(value) ? value : `'${value.replaceAll("'", "''")}'`;
}
