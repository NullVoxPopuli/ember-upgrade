import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The source folders of apps, classic addons, and v2 addons.
 */
const SOURCE_GLOBS = ["{app,addon,addon-test-support,tests,src}/**/*.{js,ts,gjs,gts}"];

const LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"];

/**
 * The project that stages read and change.
 *
 * Stages decide from the project's own files only.
 * An install is not required, because many old projects no longer install.
 */
export class Project {
  /**
   * @param {string} directory
   */
  constructor(directory) {
    this.directory = directory;
  }

  /**
   * @param {string} file relative to the project
   */
  has(file) {
    return existsSync(join(this.directory, file));
  }

  /**
   * The lockfile of the project. In a monorepo it is in a parent folder.
   * The search stops at the root of the git repository.
   *
   * @returns {{ name: string, path: string } | undefined}
   */
  get lockfile() {
    let directory = this.directory;

    for (;;) {
      for (let name of LOCKFILES) {
        if (existsSync(join(directory, name))) return { name, path: join(directory, name) };
      }

      let parent = dirname(directory);

      if (existsSync(join(directory, ".git")) || parent === directory) return;

      directory = parent;
    }
  }

  /**
   * @param {string} file relative to the project
   */
  read(file) {
    return readFileSync(join(this.directory, file), "utf8");
  }

  /**
   * Creates the folders of the file that do not exist.
   *
   * @param {string} file relative to the project
   * @param {string} contents
   */
  write(file, contents) {
    let path = join(this.directory, file);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  /**
   * Read again on each call, because stages change it.
   *
   * @returns {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string>, [key: string]: unknown }}
   */
  get packageJson() {
    return JSON.parse(this.read("package.json"));
  }

  /**
   * @param {string} name
   * @returns {string | undefined} the version range from dependencies or devDependencies
   */
  dependency(name) {
    let pkg = this.packageJson;

    return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
  }

  /**
   * @param {string[]} [patterns]
   * @returns {string[]} files relative to the project, in a stable order
   */
  files(patterns = SOURCE_GLOBS) {
    return globSync(patterns, {
      cwd: this.directory,
      exclude: (name) => name === "node_modules" || name === "dist",
    }).sort();
  }

  /**
   * @returns {string[]} the JS and TS source files of the project
   */
  sourceFiles() {
    return this.files();
  }
}
