import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** @typedef {import('#project.js').Project} Project */

/**
 * The HTML files of the app, and the environment whose config ember-cli used for each one.
 * The app's index.html served both development and production.
 */
const PAGES = [
  { file: "index.html", environments: ["production", "development"] },
  { file: "app/index.html", environments: ["production", "development"] },
  { file: "tests/index.html", environments: ["test"] },
];

const PLACEHOLDER = /^([ \t]*)\{\{content-for ["']([\w-]+)["']\}\}[ \t]*$/gm;

/**
 * @param {Project} project
 * @returns {((environment: string) => Record<string, unknown>) | undefined} the app's config/environment.js
 */
export function appConfig(project) {
  let require = createRequire(join(project.directory, "package.json"));

  for (let file of ["config/environment.js", "config/environment.cjs"]) {
    let path = join(project.directory, file);

    if (!existsSync(path)) continue;

    try {
      let exported = require(path);

      return typeof exported === "function" ? exported : exported.default;
    } catch {
      return;
    }
  }
}

/**
 * Runs a v1 addon's `contentFor` hook, as ember-cli did, and writes what it returned into the app's HTML files,
 * above each `{{content-for}}` placeholder.
 * The hook usually adds a `<script>` or `<link>` for a third-party service.
 *
 * @param {Project} project
 * @param {string} directory the installed addon
 * @returns {Record<string, string> | undefined} the new HTML files; undefined when the hook does not run, or gives development and production different HTML
 */
export function contentForPages(project, directory) {
  let config = appConfig(project);

  if (!config) return;

  let manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  let require = createRequire(join(directory, "package.json"));
  let addon;

  try {
    addon = require(join(directory, manifest["ember-addon"]?.main ?? "index.js"));
  } catch {
    return;
  }

  if (typeof addon?.contentFor !== "function") return;

  /** @type {Record<string, string>} */
  let pages = {};

  for (let page of PAGES) {
    if (!project.has(page.file)) continue;

    let html = project.read(page.file);
    /** @type {string | undefined} */
    let failed;
    let output = html.replace(PLACEHOLDER, (line, indent, type) => {
      let results = page.environments.map((environment) => {
        try {
          let value = addon.contentFor.call(addon, type, config(environment), "");

          return typeof value === "string" ? value : "";
        } catch (error) {
          failed = String(error);
          return "";
        }
      });

      if (results.some((result) => result !== results[0])) failed = "environments differ";

      let content = (results[0] ?? "").trim();

      if (content === "") return line;

      let lines = content
        .split("\n")
        .map((text) => `${indent}${text.trim()}`)
        .join("\n");

      return `${lines}\n${line}`;
    });

    if (failed) return;
    if (output !== html) pages[page.file] = output;
  }

  return pages;
}
