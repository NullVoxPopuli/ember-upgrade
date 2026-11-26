import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { buildFile, removeBuildOptions } from "#config-files.js";
import { addOverride } from "#manager-settings.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const STYLES = ["app/**/*.{scss,sass}"];
const EXTENSIONS = [".scss", ".sass", ".css"];
const IMPORT_RULE = /@(?:import|use|forward)\s+([^;{]+)/g;
const STRING = /(["'])([^"']+)\1/g;
const ENTRY_LINK = /(href=")([^"]*)@embroider\/virtual\/app\.css"/g;

/**
 * @param {string} path a file, relative or absolute
 * @returns {string} the path as Sass imports it: without the extension, the `_` of a partial, or `/index`
 */
export function sassName(path) {
  let name = path.replace(/\.(scss|sass|css)$/, "").replace(/(^|\/)_([^/]*)$/, "$1$2");

  return name.replace(/\/index$/, "");
}

/**
 * @param {string} base an absolute path without an extension
 * @returns {boolean} Sass finds a file for `@import` of the path
 */
function sassFileExists(base) {
  let folder = dirname(base);
  let name = posix.basename(base);

  for (let extension of EXTENSIONS) {
    for (let candidate of [
      join(folder, `${name}${extension}`),
      join(folder, `_${name}${extension}`),
      join(base, `index${extension}`),
      join(base, `_index${extension}`),
    ]) {
      if (existsSync(candidate)) return true;
    }
  }

  return false;
}

/**
 * @param {string} from a folder
 * @param {string} name a package
 * @returns {string | undefined} the folder of the package that Node resolves from `from`
 */
function packageFolder(from, name) {
  for (let folder = from; ; folder = dirname(folder)) {
    let candidate = join(folder, "node_modules", name);

    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(folder) === folder) return;
  }
}

/**
 * @typedef {object} Source
 * @property {string} name the package
 * @property {string} folder
 * @property {string} range the range to declare, when the app does not declare the package
 */

/**
 * The packages that ember-cli-sass reached through addons: the app's dependencies,
 * and the dependencies of its ember-cli addons, which add their own include paths.
 *
 * @param {Project} project
 * @returns {Source[]}
 */
function stylePackages(project) {
  let pkg = project.packageJson;
  let declared = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  /** @type {Source[]} */
  let direct = [];
  /** @type {Source[]} */
  let nested = [];
  /** @type {Set<string>} */
  let seen = new Set();

  for (let [name, range] of Object.entries(declared)) {
    let folder = packageFolder(project.directory, name);

    if (!folder) continue;

    direct.push({ name, folder, range: String(range) });
    seen.add(name);
  }

  for (let { folder } of direct) {
    let manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));

    if (!manifest.keywords?.includes("ember-addon")) continue;

    for (let [name, range] of Object.entries(manifest.dependencies ?? {})) {
      let dependency = seen.has(name) ? undefined : packageFolder(folder, name);

      if (!dependency) continue;

      nested.push({ name, folder: dependency, range: String(range) });
      seen.add(name);
    }
  }

  return direct.concat(nested);
}

/** @type {Map<string, string[]>} */
const STYLE_FILES = new Map();

/**
 * @param {Source} source
 * @returns {string[]} the stylesheets of the package, as Sass imports them
 */
function styleNames(source) {
  let names = STYLE_FILES.get(source.folder);

  if (!names) {
    names = globSync("**/*.{scss,sass,css}", {
      cwd: source.folder,
      exclude: (name) => name === "node_modules",
    }).map((file) => sassName(file.split("\\").join("/")));
    STYLE_FILES.set(source.folder, names);
  }

  return names;
}

/**
 * @typedef {object} Resolution
 * @property {string} [specifier] the import that Vite resolves
 * @property {string} [declare] the package that the app must declare for it
 * @property {string} [range]
 * @property {string[]} [candidates] the files that match, when more than one does
 */

/**
 * A package with `exports` resolves only the paths that it lists, with their extensions,
 * so `x/x` becomes `x/x.scss`, or `x` when the `sass` condition of the package entry is that file.
 *
 * @param {Source} source
 * @param {string} specifier
 * @returns {Resolution | undefined} undefined when the import is not into this package, or already resolves
 */
function fromExports(source, specifier) {
  if (!specifier.startsWith(`${source.name}/`)) return;

  let exports = JSON.parse(readFileSync(join(source.folder, "package.json"), "utf8")).exports;

  if (!exports || typeof exports !== "object") return;

  let rest = specifier.slice(source.name.length + 1);

  if (`./${rest}` in exports) return;

  let file = globSync("**/*.{scss,sass,css}", {
    cwd: source.folder,
    exclude: (name) => name === "node_modules",
  })
    .map((path) => path.split("\\").join("/"))
    .find((path) => sassName(path) === rest);

  if (!file) return;

  let resolved = { declare: source.name, range: source.range };

  if (exports["."]?.sass === `./${file}`)
    return Object.assign({ specifier: source.name }, resolved);
  if (`./${file}` in exports)
    return Object.assign({ specifier: `${source.name}/${file}` }, resolved);
}

/**
 * @param {Source} source
 * @param {string} specifier
 * @returns {Resolution | undefined}
 */
function fromPackageFiles(source, specifier) {
  let found = styleNames(source)
    .filter((name) => name === specifier || name.endsWith(`/${specifier}`))
    .sort((a, b) => a.split("/").length - b.split("/").length);
  let [first, second] = found;

  if (!first) return;

  if (second && second.split("/").length === first.split("/").length) {
    return { candidates: found.map((name) => `${source.name}/${name}`) };
  }

  return { specifier: `${source.name}/${first}`, declare: source.name, range: source.range };
}

/**
 * ember-cli merged the `app/styles` of addons into the app's styles, and addons added
 * the folders of their own dependencies as include paths.
 *
 * @param {Project} project
 * @param {string} file the stylesheet with the import
 * @param {string} specifier
 * @param {{ roots: string[], packages: Source[] }} context
 * @returns {Resolution | undefined} undefined when the import already resolves, or nothing matches
 */
export function resolveImport(project, file, specifier, context) {
  if (/^(sass:|https?:|\/\/|url\()/.test(specifier) || specifier.endsWith(".css")) return;

  let folder = posix.dirname(file);

  if (specifier.startsWith("node_modules/")) {
    let path = specifier.slice("node_modules/".length);
    let name = path.startsWith("@")
      ? path.split("/").slice(0, 2).join("/")
      : String(path.split("/")[0]);
    let source = context.packages.find((candidate) => candidate.name === name);
    let installed = source ? undefined : packageFolder(project.directory, name);
    let version =
      installed && JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version;

    return { specifier: path, declare: name, range: source?.range ?? (version && `^${version}`) };
  }

  if (sassFileExists(join(project.directory, folder, specifier))) return;

  for (let root of context.roots) {
    if (!sassFileExists(join(project.directory, root, specifier))) continue;

    let relative = posix.relative(folder, posix.join(root, specifier));

    return { specifier: relative.startsWith(".") ? relative : `./${relative}` };
  }

  for (let source of context.packages) {
    let resolution = fromExports(source, specifier);

    if (resolution) return resolution;
  }

  for (let source of context.packages) {
    if (sassFileExists(join(source.folder, "app", "styles", specifier))) {
      return {
        specifier: `${source.name}/app/styles/${specifier}`,
        declare: source.name,
        range: source.range,
      };
    }
  }

  for (let source of context.packages) {
    let resolution = fromPackageFiles(source, specifier);

    if (resolution) return resolution;
  }
}

/**
 * @param {Project} project
 * @returns {string[]} the folders that the app adds with `sassOptions.includePaths`
 */
function includePaths(project) {
  let file = buildFile(project);
  let options = file ? /includePaths\s*:\s*\[([^\]]*)\]/.exec(project.read(file)) : undefined;

  return Array.from(String(options?.[1] ?? "").matchAll(STRING), (match) =>
    String(match[2]).replace(/\/$/, ""),
  );
}

/**
 * Vite compiles Sass when the app installs `sass`, so ember-cli-sass and its include paths can go.
 * ember-cli-sass resolved `@import` from app/styles, the include paths, and the styles that addons add.
 * Vite resolves relative paths and packages only, so each other import becomes one of those.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "vite-sass",
  label: "Compile Sass with Vite, not ember-cli-sass",
  needsInstall: true,

  detect(project) {
    return Boolean(project.dependency("ember-cli-sass") && project.dependency("@embroider/vite"));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let context = {
      roots: ["app/styles"].concat(includePaths(project)),
      packages: stylePackages(project),
    };
    /** @type {Map<string, string | undefined>} */
    let declare = new Map();
    /** @type {import('#types.js').Finding[]} */
    let todo = [];

    for (let file of project.files(STYLES)) {
      let source = project.read(file);
      let output = source.replace(IMPORT_RULE, (rule) =>
        rule.replace(STRING, (literal, quote, specifier) => {
          let resolution = resolveImport(project, file, specifier, context);

          if (resolution?.candidates) {
            todo.push({
              title: `Choose the file that \`@import "${specifier}"\` means`,
              where: [file],
              action: `More than one package file matches: ${resolution.candidates.join(", ")}.`,
            });
          }

          if (!resolution?.specifier) return literal;
          if (resolution.declare) declare.set(resolution.declare, resolution.range);

          return `${quote}${resolution.specifier}${quote}`;
        }),
      );

      if (output !== source) project.write(file, output);
    }

    let entry = ["app/styles/app.scss", "app/styles/app.sass"].find((file) => project.has(file));

    for (let html of ["index.html", "tests/index.html"]) {
      if (!entry || !project.has(html)) continue;

      project.write(
        html,
        project
          .read(html)
          .replace(ENTRY_LINK, (_link, href, prefix) => `${href}${prefix}${entry}"`),
      );
    }

    if (!entry) {
      todo.push({
        title: "Link the app's Sass entry from index.html",
        where: ["index.html"],
        action: "Vite compiles a stylesheet that index.html links, such as `/app/styles/app.scss`.",
      });
    }

    let removed = removeBuildOptions(project, ["sassOptions"]);

    editPackageJson(project, (pkg) => {
      removeDependency(pkg, "ember-cli-sass");
      removeDependency(pkg, "node-sass");
      setDependency(pkg, "sass", `^${published("sass")?.version ?? "1.94.2"}`);

      for (let [name, range] of declare) {
        if (range && !pkg.dependencies?.[name] && !pkg.devDependencies?.[name]) {
          setDependency(pkg, name, range);
        }
      }
    });

    let compiling = context.packages
      .filter(({ folder }) => {
        let manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));

        return Boolean(manifest.dependencies?.["ember-cli-sass"]);
      })
      .map(({ name }) => name);

    /**
     * ember-cli-sass before 10 compiles with node-sass, which does not build for current Node versions.
     */
    if (compiling.length > 0) {
      addOverride(
        project,
        "ember-cli-sass",
        `^${published("ember-cli-sass")?.version ?? "11.0.1"}`,
      );
      recordProgress(project, {
        id: "vite-sass: ember-cli-sass",
        status: "override",
        note:
          `${compiling.join(", ")} compile their own Sass with ember-cli-sass, so an override forces the latest ember-cli-sass, which uses sass. ` +
          "Remove the override when no dependency needs ember-cli-sass.",
      });
    }

    recordProgress(project, {
      id: "vite-sass",
      status: "changed",
      note:
        "Vite compiles the app's Sass now, with sass (Dart Sass), and index.html links the Sass entry. " +
        "Imports that ember-cli-sass found through app/styles, include paths, or addons are relative paths or package paths now" +
        (declare.size > 0
          ? `, and the app declares ${Array.from(declare.keys()).join(", ")}`
          : "") +
        (removed.length > 0 ? ". The sassOptions of ember-cli-build are gone" : "") +
        ". Dart Sass deprecates some Sass features, such as `/` for division. Check the build output for warnings.",
      links: ["https://vite.dev/guide/features.html#css-pre-processors"],
    });

    return todo;
  },
};
