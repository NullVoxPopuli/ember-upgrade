import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { parseProgram, propertyName, walk } from "#ast.js";
import { removeProperty } from "#config-files.js";
import { Edits } from "#edits.js";
import { runUpstream } from "#process.js";
import { readProgress, recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const ENVIRONMENT = "config/environment.js";
/**
 * Only pods name a template `template.hbs`. Other pod file names, such as `route.js`, are also plain module names.
 */
const POD_TEMPLATES = ["app/**/template.hbs"];
const SOURCES = ["{app,tests,lib,mirage}/**/*.{js,ts,gjs,gts}"];
const EXTENSION = /\.(js|ts|gjs|gts|hbs|scss|css)$/;
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * @param {Project} project
 * @returns {{ modulePrefix?: string, podModulePrefix?: string }}
 */
function environmentPrefixes(project) {
  if (!project.has(ENVIRONMENT)) return {};

  let program = parseProgram(project.read(ENVIRONMENT), ENVIRONMENT);
  /** @type {{ modulePrefix?: string, podModulePrefix?: string }} */
  let prefixes = {};

  walk(program, (node) => {
    let name = propertyName(node);

    if ((name === "modulePrefix" || name === "podModulePrefix") && node.value.type === "Literal") {
      prefixes[name] ??= String(node.value.value);
    }
  });

  return prefixes;
}

/**
 * @param {Project} project
 * @returns {boolean} `.ember-cli` sets `usePods`
 */
function usesPods(project) {
  return project.has(".ember-cli") && /"?usePods"?\s*:\s*true/.test(project.read(".ember-cli"));
}

/**
 * @param {Project} project
 * @returns {Map<string, string>} each file that moved, from its old path to its new one
 */
function moves(project) {
  spawnSync("git", ["add", "-A", "--", "app", "tests"], { cwd: project.directory });

  let result = spawnSync(
    "git",
    ["diff", "--cached", "--relative", "-M100%", "--name-status", "-z", "--", "app", "tests"],
    { cwd: project.directory, encoding: "utf8" },
  );
  let fields = result.stdout.split("\0");
  /** @type {Map<string, string>} */
  let moved = new Map();

  for (let i = 0; i < fields.length; i++) {
    if (fields[i]?.startsWith("R")) {
      moved.set(String(fields[i + 1]), String(fields[i + 2]));
      i += 2;
    }
  }

  return moved;
}

/**
 * @param {string} file
 * @returns {string} the module path, without the extension
 */
function modulePath(file) {
  return file.replace(EXTENSION, "");
}

/**
 * Rewrites the imports of moved modules, and the relative imports of moved files.
 *
 * @param {string} source
 * @param {{ file: string, origin: string, prefix: string, modules: Map<string, string> }} context
 *   `origin` is where the file was before the move, and `modules` maps old paths to new ones,
 *   with and without the extension
 * @returns {string}
 */
export function rewriteImports(source, { file, origin, prefix, modules }) {
  return source.replace(SPECIFIER, (match, before, quote, specifier) => {
    if (specifier.startsWith(`${prefix}/`)) {
      let target = modules.get(`app/${specifier.slice(prefix.length + 1)}`);

      return target ? `${before}${quote}${prefix}/${target.slice("app/".length)}${quote}` : match;
    }

    if (!specifier.startsWith(".")) return match;

    let resolved = posix.normalize(posix.join(posix.dirname(origin), specifier));
    let target = modules.get(resolved) ?? resolved;

    if (target === resolved && file === origin) return match;

    let relative = posix.relative(posix.dirname(file), target);

    if (!relative.startsWith("../")) return `${before}${quote}./${relative}${quote}`;

    /**
     * A far-away file goes through the module prefix, which ember.nvp turns into a subpath import.
     */
    let absolute = target.startsWith("app/") ? target.slice("app/".length) : target;

    return `${before}${quote}${prefix}/${absolute}${quote}`;
  });
}

/**
 * Ember apps converge on the default layout, where @embroider/template-tag-codemod and ember.nvp read them.
 * ember-codemod-pod-to-octane moves the files, and this stage updates what pointed at them.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "pods",
  label: "Move pods to the default layout (ember-codemod-pod-to-octane)",

  detect(project) {
    /**
     * Files that only have the name of a pod file stay, so the progress entry shows that the stage ran.
     */
    if (readProgress(project).some((entry) => entry.id === "pods")) return false;

    return (
      usesPods(project) ||
      Boolean(environmentPrefixes(project).podModulePrefix) ||
      project.files(POD_TEMPLATES).length > 0
    );
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let { modulePrefix, podModulePrefix } = environmentPrefixes(project);
    let prefix = modulePrefix ?? String(project.packageJson.name);
    let args = ["--type", "app"];

    if (podModulePrefix?.startsWith(`${prefix}/`)) {
      args.push("--pod-path", podModulePrefix.slice(prefix.length + 1));
    }

    if (!runUpstream(project, "ember-codemod-pod-to-octane@5.1.8", args)) {
      throw new Error("ember-codemod-pod-to-octane failed. Its output is above.");
    }

    /** @type {string[]} */
    let movedBack = [];
    let moved = moves(project);

    /**
     * Every pod module has a default export, so a file without one only had a pod's name,
     * such as ember-osf-web's app/decorators/component.ts.
     */
    for (let [from, to] of moved) {
      if (!/\.(js|ts)$/.test(to) || /\bexport\s+default\b/.test(project.read(to))) continue;

      mkdirSync(dirname(join(project.directory, from)), { recursive: true });
      renameSync(join(project.directory, to), join(project.directory, from));
      moved.delete(from);
      movedBack.push(from);
    }

    /** @type {Map<string, string>} */
    let modules = new Map();
    /** @type {Map<string, string>} */
    let origins = new Map();

    for (let [from, to] of moved) {
      modules.set(from, to);
      modules.set(modulePath(from), modulePath(to));
      origins.set(to, from);
    }

    for (let file of project.files(SOURCES)) {
      let source = project.read(file);
      let output = rewriteImports(source, {
        file,
        origin: origins.get(file) ?? file,
        prefix,
        modules,
      });

      if (output !== source) project.write(file, output);
    }

    if (usesPods(project)) {
      let source = project.read(".ember-cli");
      let followed = /\s*"?usePods"?\s*:\s*true\s*,/;

      project.write(
        ".ember-cli",
        followed.test(source)
          ? source.replace(followed, "")
          : source.replace(/,(\s*)"?usePods"?\s*:\s*true/, ""),
      );
    }

    if (podModulePrefix) {
      let source = project.read(ENVIRONMENT);
      let edits = new Edits(source);

      walk(parseProgram(source, ENVIRONMENT), (node) => {
        if (propertyName(node) === "podModulePrefix") removeProperty(edits, node);
      });

      project.write(ENVIRONMENT, edits.apply());
    }

    recordProgress(project, {
      id: "pods",
      status: "changed",
      note:
        `ember-codemod-pod-to-octane moved ${moved.size} files from pods to the default layout, ` +
        "and the imports of those files point to the new paths." +
        (movedBack.length > 0
          ? ` ${movedBack.join(", ")} stayed, because they only have the name of a pod file.`
          : ""),
      links: ["https://github.com/ijlee2/ember-codemod-pod-to-octane"],
    });

    return [];
  },
};
