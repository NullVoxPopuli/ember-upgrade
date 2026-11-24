import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { readProgress } from "#progress.js";
import emberCliServer from "#stages/ember-cli-server/index.js";

/**
 * @param {Record<string, string | object>} files
 */
function project(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(
      join(directory, file),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }

  return new Project(directory);
}

const VITE_CONFIG = `import { defineConfig } from "vite";
import { ember } from "@nullvoxpopuli/ember-vite";

export default defineConfig({
  plugins: [ember()],
});
`;

/**
 * From emberobserver/client, shortened.
 */
const SERVER = `module.exports = function (app) {
  var globSync = require('glob').sync;
  var proxies = globSync('./proxies/**/*.js', { cwd: __dirname }).map(require);

  //   app.get('/ember-hamsters', function(req, res) {
  //     res.send('hello');
  //   });

  proxies.forEach(function (route) {
    route(app);
  });
};
`;

test("the Vite dev server runs server/index.js, which stays CommonJS", async () => {
  let app = project({
    "package.json": { name: "ember-observer", type: "module" },
    "vite.config.mjs": VITE_CONFIG,
    "server/index.js": SERVER,
    "server/proxies/api.js": `module.exports = function (app) { app.use('/api', function () {}); };\n`,
  });

  expect(emberCliServer.detect(app)).toBe(true);

  await emberCliServer.run(app);

  expect(app.read("vite.config.mjs")).toMatchInlineSnapshot(`
    "import { defineConfig } from "vite";
    import { ember } from "@nullvoxpopuli/ember-vite";
    import emberCliServer from "./server/vite.mjs";

    export default defineConfig({
      plugins: [ember(), emberCliServer()],
    });
    "
  `);
  expect(app.read("server/package.json")).toMatchInlineSnapshot(`
    "{
      "type": "commonjs"
    }
    "
  `);
  expect(app.read("server/vite.mjs")).toMatchInlineSnapshot(`
    "import { createRequire } from "node:module";

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
    "
  `);
  expect(emberCliServer.detect(app)).toBe(false);
});

test("a server that calls Express methods stays for the app's maintainers", async () => {
  let app = project({
    "package.json": { name: "app" },
    "vite.config.mjs": VITE_CONFIG,
    "server/index.js": `module.exports = function (app) {\n  app.get('/api/me', (req, res) => res.json({}));\n};\n`,
  });

  await emberCliServer.run(app);

  expect(app.read("vite.config.mjs")).toBe(VITE_CONFIG);
  expect(app.has("server/vite.mjs")).toBe(false);
  expect(readProgress(app).map((entry) => entry.status)).toEqual(["todo"]);
  expect(emberCliServer.detect(app)).toBe(false);
});
