import { addVitePlugin, viteConfig } from "#config-files.js";
import { editPackageJson } from "#package-json.js";
import { readProgress, recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const PLUGIN = "server/proxy.mjs";
const PROGRESS_ID = "ember-serve-proxy";
const LINKS = ["https://vite.dev/guide/api-plugin#configureserver"];

/**
 * `ember serve` or `ember s`, with the options after it, up to the end of that command.
 */
const SERVE = /\bember\s+(?:serve|s)\b([^&|;]*)/;

/**
 * `--proxy <url>`, `--proxy=<url>`, and the short form `-pr`.
 */
const PROXY = /\s(?:--proxy|-pr)(?:\s+|=)(\S+)/;

/**
 * @param {string} command
 * @returns {{ target: string, command: string, rest: string } | undefined} rest is the other `ember serve` options
 */
export function proxyScript(command) {
  let serve = command.match(SERVE);
  let proxy = serve?.[1].match(PROXY);

  if (!serve || !proxy) return;

  let rest = serve[1].replace(proxy[0], "").trim();
  let start = /** @type {number} */ (serve.index);
  let vite = serve[1].endsWith(" ") ? "vite " : "vite";

  return {
    target: proxy[1].replace(/^["']|["']$/g, ""),
    command: `${command.slice(0, start)}${vite}${command.slice(start + serve[0].length)}`.trim(),
    rest,
  };
}

/**
 * @param {Record<string, string>} targets the backend of each package.json script
 */
export function pluginSource(targets) {
  return `import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

/**
 * The backend of each package.json script, from its \`ember serve --proxy\` command.
 */
const TARGETS = ${JSON.stringify(targets, null, 2)};

/**
 * Sends the requests that the app does not serve to a backend, as \`ember serve --proxy\` did.
 * Page loads, Vite's own URLs, and files in the project or in public/ stay with Vite.
 * The script that starts Vite selects the backend.
 *
 * @returns {import("vite").Plugin}
 */
export default function emberServeProxy() {
  let target = TARGETS[process.env.npm_lifecycle_event];

  return {
    name: "ember-serve-proxy",
    apply: "serve",
    configureServer(server) {
      if (!target) return;

      let backend = new URL(target);
      let request = backend.protocol === "https:" ? httpsRequest : httpRequest;
      let base = backend.pathname.replace(/\\/$/, "");

      server.middlewares.use((req, res, next) => {
        let path = decodeURIComponent(req.url.split("?")[0]);

        if (
          req.headers.accept?.includes("text/html") ||
          path.startsWith("/@") ||
          path.startsWith("/node_modules/") ||
          existsSync(join(server.config.root, path)) ||
          existsSync(join(server.config.publicDir, path))
        ) {
          return next();
        }

        let upstream = request(
          {
            protocol: backend.protocol,
            hostname: backend.hostname,
            port: backend.port,
            method: req.method,
            path: base + req.url,
            headers: Object.assign({}, req.headers, { host: backend.host }),
          },
          (response) => {
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
          },
        );

        upstream.on("error", (error) => {
          server.config.logger.error(\`ember-serve-proxy: \${req.url}: \${error.message}\`);
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });

        req.pipe(upstream);
      });
    },
  };
}
`;
}

/**
 * @param {Project} project
 * @returns {Record<string, ReturnType<typeof proxyScript>>}
 */
function proxyScripts(project) {
  /** @type {Record<string, ReturnType<typeof proxyScript>>} */
  let found = {};
  let scripts = project.packageJson.scripts ?? {};

  for (let [name, command] of Object.entries(scripts)) {
    let script = proxyScript(String(command));

    if (script) found[name] = script;
  }

  return found;
}

/**
 * `ember serve --proxy <url>` sent the requests that the app did not serve to a backend.
 * Vite has no such option, and ember.nvp removes the `ember serve` scripts.
 * Each script starts Vite now, and a plugin in server/ maps the script's name to its backend.
 * It runs before the vite stage, which replaces the `start` script.
 *
 * @type {import('#types.js').Stage}
 */
export const proxyScriptsStage = {
  name: "ember-serve-proxy",
  label: "Start Vite in the `ember serve --proxy` scripts, with a plugin for the proxy",

  detect(project) {
    return project.has("package.json") && Object.keys(proxyScripts(project)).length > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let scripts = proxyScripts(project);
    /** @type {Record<string, string>} */
    let targets = {};
    /** @type {string[]} */
    let options = [];

    for (let [name, script] of Object.entries(scripts)) {
      if (!script) continue;

      targets[name] = script.target;

      if (script.rest) options.push(`${name}: ${script.rest}`);
    }

    editPackageJson(project, (pkg) => {
      for (let [name, script] of Object.entries(scripts)) {
        if (script) pkg.scripts[name] = script.command;
      }
    });

    project.write(PLUGIN, pluginSource(targets));

    if (options.length > 0) {
      recordProgress(project, {
        id: `${PROGRESS_ID}: options`,
        status: "todo",
        note:
          `These scripts started Vite in place of \`ember serve\`, without its other options: ${options.join("; ")}. ` +
          "Give each option to Vite, or remove it.",
        links: ["https://vite.dev/guide/cli#vite"],
      });
    }

    return [];
  },
};

/**
 * Adds the proxy plugin to the Vite config. It runs after ember-nvp, which writes the Vite config.
 *
 * @type {import('#types.js').Stage}
 */
export const proxyPluginStage = {
  name: "ember-serve-proxy-plugin",
  label: "Add the `ember serve --proxy` plugin to the Vite config",

  detect(project) {
    if (!project.has(PLUGIN) || !viteConfig(project)) return false;

    return !readProgress(project).some((entry) => entry.id === PROGRESS_ID);
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let added = addVitePlugin(project, {
      importLine: `import emberServeProxy from "./${PLUGIN}";`,
      call: "emberServeProxy()",
      specifier: `./${PLUGIN}`,
    });

    recordProgress(project, {
      id: PROGRESS_ID,
      status: added ? "moved" : "todo",
      note: added
        ? `The scripts that ran \`ember serve --proxy\` start Vite, and the plugin in ${PLUGIN} proxies their requests.`
        : `Add the plugin in ${PLUGIN} to the plugins of the Vite config, so that the proxy scripts reach their backend.`,
      links: LINKS,
    });

    return [];
  },
};
