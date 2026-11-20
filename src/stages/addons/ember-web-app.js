import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { editPackageJson, removeDependency } from "#package-json.js";

/** @typedef {import('#types.js').Finding} Finding */

const MANIFEST_CONFIG = "config/manifest.js";
const MANIFEST = "public/manifest.webmanifest";
const INDEX_FILES = ["app/index.html", "index.html"];

/**
 * Runs config/manifest.js the way ember-web-app runs it in a production build.
 *
 * @param {import('#project.js').Project} project
 * @returns {Record<string, any>}
 */
function manifestConfig(project) {
  let require = createRequire(join(project.directory, "package.json"));
  let environment = require(join(project.directory, "config/environment.js"))("production");

  return require(join(project.directory, MANIFEST_CONFIG))("production", environment);
}

/**
 * @param {string} value
 */
function attribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * The tags that ember-web-app adds to the head.
 *
 * @param {Record<string, any>} manifest
 * @returns {string[]}
 */
function headTags(manifest) {
  let tags = [`<link rel="manifest" href="/manifest.webmanifest">`];

  if (manifest.theme_color)
    tags.push(`<meta name="theme-color" content="${attribute(manifest.theme_color)}">`);

  if (manifest.display === "standalone" || manifest.display === "fullscreen") {
    tags.push(`<meta name="apple-mobile-web-app-capable" content="yes">`);
  }

  if (manifest.short_name ?? manifest.name) {
    tags.push(
      `<meta name="apple-mobile-web-app-title" content="${attribute(manifest.short_name ?? manifest.name)}">`,
    );
  }

  if (manifest.apple?.statusBarStyle) {
    tags.push(
      `<meta name="apple-mobile-web-app-status-bar-style" content="${attribute(manifest.apple.statusBarStyle)}">`,
    );
  }

  return tags;
}

/**
 * ember-web-app has no v2 release, and its ember-cli hooks read app/index.html,
 * which the vite stage moves. So it goes before the vite stage.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ember-web-app",
  label: "Replace ember-web-app with public/manifest.webmanifest and tags in index.html",

  detect(project) {
    return Boolean(project.dependency("ember-web-app"));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    /** @type {Finding[]} */
    let todo = [];
    let index = INDEX_FILES.find((file) => project.has(file));

    if (project.has(MANIFEST_CONFIG)) {
      /** @type {Record<string, any>} */
      let config;

      try {
        config = manifestConfig(project);
      } catch (error) {
        throw new Error(
          `${MANIFEST_CONFIG} did not run: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      let manifest = Object.assign({}, config);

      /**
       * These keys are options of ember-web-app, and not part of the web manifest.
       */
      delete manifest.apple;
      delete manifest.ms;

      project.write(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

      if (index) {
        let html = project.read(index);
        let tags = headTags(config)
          .map((tag) => `    ${tag}\n`)
          .join("");
        let marker =
          html.match(/^[ \t]*\{\{content-for "head-footer"\}\}/m) ?? html.match(/^[ \t]*<\/head>/m);

        if (marker?.index !== undefined) {
          project.write(index, html.slice(0, marker.index) + tags + html.slice(marker.index));
        } else {
          todo.push({
            title: "Add the web manifest tags to index.html",
            where: [index],
            action: tags,
          });
        }
      }

      if (config.ms) {
        todo.push({
          title:
            "ember-web-app wrote browserconfig.xml for the `ms` options. Nothing writes it now.",
          where: [MANIFEST_CONFIG],
          action: "Add public/browserconfig.xml if the app still needs it.",
        });
      }

      rmSync(join(project.directory, MANIFEST_CONFIG));
    }

    editPackageJson(project, (pkg) => removeDependency(pkg, "ember-web-app"));

    return todo;
  },
};
