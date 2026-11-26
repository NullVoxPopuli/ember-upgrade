import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

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
 * @returns {number} the `minimumReleaseAge` setting of pnpm in minutes, or 0
 */
export function releaseAge(project) {
  let root = workspaceRoot(project);
  let yaml = root.has(WORKSPACE_FILE) ? root.read(WORKSPACE_FILE) : "";
  let npmrc = root.has(".npmrc") ? root.read(".npmrc") : "";
  let value =
    /^minimumReleaseAge:\s*(\d+)/m.exec(yaml)?.[1] ??
    /^minimum-release-age\s*=\s*(\d+)/m.exec(npmrc)?.[1];

  return Number(value ?? 0);
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
 * @param {Project} project
 * @param {string} name
 * @returns {boolean} the project already forces a version of the package
 */
export function hasOverride(project, name) {
  let root = workspaceRoot(project);
  let pkg = JSON.parse(root.read("package.json"));
  let maps = [pkg.resolutions, pkg.overrides, pkg.pnpm?.overrides];

  if (maps.some((map) => map && name in map)) return true;

  if (!root.has(WORKSPACE_FILE)) return false;

  let quoted = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

  return new RegExp(`^overrides:[^]*?^\\s+['"]?${quoted}['"]?:`, "m").test(
    root.read(WORKSPACE_FILE),
  );
}

/**
 * @param {Project} project
 * @param {string} name
 * @returns {string | undefined} the range that package.json or pnpm-workspace.yaml forces for the package
 */
export function overrideRange(project, name) {
  let root = workspaceRoot(project);
  let pkg = JSON.parse(root.read("package.json"));

  for (let map of [pkg.resolutions, pkg.overrides, pkg.pnpm?.overrides]) {
    if (map && typeof map[name] === "string") return map[name];
  }

  if (root.has(WORKSPACE_FILE)) return yamlMapEntry(root.read(WORKSPACE_FILE), "overrides", name);
}

/**
 * Removes the version that package.json or pnpm-workspace.yaml forces for the package.
 *
 * @param {Project} project
 * @param {string} name
 */
export function removeOverride(project, name) {
  let root = workspaceRoot(project);

  editPackageJson(root, (pkg) => {
    for (let map of [pkg.resolutions, pkg.overrides, pkg.pnpm?.overrides]) {
      if (map) delete map[name];
    }
  });

  if (root.has(WORKSPACE_FILE)) {
    root.write(WORKSPACE_FILE, removeYamlMapEntry(root.read(WORKSPACE_FILE), "overrides", name));
  }
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

  /**
   * pnpm ignores the overrides in pnpm-workspace.yaml when package.json has `resolutions`
   * (crates.io), so the override goes next to the ones the project already has.
   */
  let resolutions = Boolean(JSON.parse(root.read("package.json")).resolutions);

  if (pm === "pnpm" && !resolutions) return setPnpmMapSetting(project, "overrides", name, range);

  let field = pm === "yarn" || resolutions ? "resolutions" : "overrides";

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
 * @param {string} key a block map, such as `overrides`
 * @param {string} name
 * @returns {string | undefined} the value of the entry, without quotes
 */
export function yamlMapEntry(source, key, name) {
  /** @type {string | undefined} */
  let value;

  editBlock(source, key, (entries) => {
    let entry = entries.find((line) => entryName(line) === name);

    value = entry?.slice(entry.indexOf(":", entry.indexOf(name) + name.length) + 1).trim();

    return entries;
  });

  return /** @type {string | undefined} */ (value)?.replace(/^(['"])(.*)\1$/, "$2");
}

/**
 * @param {string} source
 * @param {string} key
 * @param {string} name
 * @returns {string} the source without the entry, and without the block when it was the only one
 */
export function removeYamlMapEntry(source, key, name) {
  let output = editBlock(source, key, (entries) =>
    entries.filter((entry) => entryName(entry) !== name),
  );

  return output.replace(new RegExp(`^${key}:\\n(?=\\S|\\n|$)`, "m"), "");
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

/**
 * pnpm stops on a patch of a package that the project no longer installs, so a removal takes its patches too.
 *
 * @param {Project} project
 * @param {string} name such as `ember-data-fastboot`, for the keys `ember-data-fastboot` and `ember-data-fastboot@0.1.2`
 * @returns {string[]} the patch files that went
 */
export function removePatches(project, name) {
  let root = workspaceRoot(project);
  /** @type {string[]} */
  let removed = [];
  let matches = (/** @type {string} */ key) => key === name || key.startsWith(`${name}@`);

  if (root.has(WORKSPACE_FILE)) {
    let source = root.read(WORKSPACE_FILE);
    let lines = source.split("\n");
    let start = lines.findIndex((line) => line.startsWith("patchedDependencies:"));
    /** @type {string[]} */
    let keys = [];

    for (let index = start + 1; start !== -1 && index < lines.length; index++) {
      let line = String(lines[index]);

      if (line.trim() !== "" && !/^\s/.test(line)) break;

      let key = entryName(line);

      if (key && matches(key)) keys.push(key);
    }

    for (let key of keys) {
      let file = yamlMapEntry(source, "patchedDependencies", key);

      source = removeYamlMapEntry(source, "patchedDependencies", key);
      if (file) removed.push(file);
    }

    if (keys.length > 0) root.write(WORKSPACE_FILE, source);
  }

  editPackageJson(root, (pkg) => {
    let patches = pkg.pnpm?.patchedDependencies;

    if (!patches) return;

    for (let key of Object.keys(patches)) {
      if (!matches(key)) continue;

      removed.push(String(patches[key]));
      delete patches[key];
    }
  });

  for (let file of removed) rmSync(join(root.directory, file), { force: true });

  return removed;
}
