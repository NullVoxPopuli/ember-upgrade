import { addVitePlugin, viteConfig } from "#config-files.js";
import { readProgress, recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const ENTRY = "server/index.js";
const PLUGIN = "server/vite.mjs";
const PROGRESS_ID = "ember-cli-server";

/**
 * The Express methods that Vite's middleware stack, a connect app, does not have.
 */
const EXPRESS_ONLY =
  /^(?!\s*(\/\/|\/\*|\*)).*\bapp\.(get|post|put|patch|delete|all|route|param|listen)\(/m;

const PLUGIN_SOURCE = `import { createRequire } from "node:module";

/**
 * Runs server/index.js in the Vite dev server, as \`ember serve\` did, for the app's proxies and mocks.
 *
 * @returns {import("vite").Plugin}
 */
export default function emberCliServer() {
  return {
    name: "ember-cli-server",
    configureServer(server) {
      createRequire(import.meta.url)("./index.js")(server.middlewares);
    },
  };
}
`;

/**
 * @param {Project} project
 * @returns {string[]} the server files that call an Express-only method
 */
function expressOnly(project) {
  return project.files(["server/**/*.js"]).filter((file) => EXPRESS_ONLY.test(project.read(file)));
}

/**
 * `ember serve` called server/index.js with its Express app, for proxies and mock APIs in development.
 * Vite does not, so the dev server lost them. A Vite plugin calls the same module with Vite's middleware stack,
 * which has `app.use`. The folder stays CommonJS when the app's package.json says `"type": "module"`.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ember-cli-server",
  label: "Run the ember-cli server/ folder in the Vite dev server",

  detect(project) {
    if (!project.has(ENTRY) || !viteConfig(project)) return false;

    return !readProgress(project).some((entry) => entry.id === PROGRESS_ID);
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let express = expressOnly(project);

    if (express.length > 0) {
      recordProgress(project, {
        id: PROGRESS_ID,
        status: "todo",
        note:
          `ember serve ran ${ENTRY} in development, and Vite does not. ` +
          `These files call Express methods, which Vite's dev server does not have: ${express.join(", ")}. ` +
          "Move the proxies to `server.proxy` in the Vite config, and the mocks to a Vite plugin or to Mirage.",
        links: ["https://vite.dev/config/server-options#server-proxy"],
      });

      return [];
    }

    project.write(PLUGIN, PLUGIN_SOURCE);

    if (project.packageJson.type === "module" && !project.has("server/package.json")) {
      project.write("server/package.json", `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);
    }

    let added = addVitePlugin(project, {
      importLine: `import emberCliServer from "./${PLUGIN}";`,
      call: "emberCliServer()",
      specifier: `./${PLUGIN}`,
    });

    recordProgress(project, {
      id: PROGRESS_ID,
      status: added ? "moved" : "todo",
      note: added
        ? `The Vite dev server runs ${ENTRY}, as ember serve did, through the plugin in ${PLUGIN}. ` +
          "Vite's `server.proxy` option can replace the proxies."
        : `Add the plugin in ${PLUGIN} to the plugins of the Vite config, so that the dev server runs ${ENTRY}.`,
      links: ["https://vite.dev/config/server-options#server-proxy"],
    });

    return [];
  },
};
