import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer as createViteServer } from "vite";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { readProgress } from "#progress.js";
import {
  proxyPluginStage,
  proxyScript,
  proxyScriptsStage,
} from "#stages/ember-serve-proxy/index.js";

/**
 * @param {Record<string, string | object>} files
 */
function project(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(
      join(directory, file),
      typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
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

test("the forms of ember serve --proxy", () => {
  expect(proxyScript("ember serve --proxy https://crates.io")).toMatchInlineSnapshot(`
    {
      "command": "vite",
      "rest": "",
      "target": "https://crates.io",
    }
  `);
  expect(proxyScript("ember s --port 4300 --proxy=http://localhost:3000 && echo done"))
    .toMatchInlineSnapshot(`
      {
        "command": "vite && echo done",
        "rest": "--port 4300",
        "target": "http://localhost:3000",
      }
    `);
  expect(proxyScript("ember serve")).toBeUndefined();
  expect(proxyScript("ember test --proxy http://localhost")).toBeUndefined();
});

test("the proxy scripts start Vite, and the plugin maps each script to its backend", async () => {
  /**
   * From rust-lang/crates.io, shortened.
   */
  let app = project({
    "package.json": {
      name: "crates-io",
      scripts: {
        start: "ember serve",
        "start:live": "ember serve --proxy https://crates.io",
        "start:local": "ember serve --proxy http://127.0.0.1:8888",
      },
    },
  });

  expect(proxyScriptsStage.detect(app)).toBe(true);

  await proxyScriptsStage.run(app);

  expect(app.packageJson.scripts).toMatchInlineSnapshot(`
    {
      "start": "ember serve",
      "start:live": "vite",
      "start:local": "vite",
    }
  `);
  expect(app.read("server/proxy.mjs")).toContain(`const TARGETS = {
  "start:live": "https://crates.io",
  "start:local": "http://127.0.0.1:8888"
};`);
  expect(proxyScriptsStage.detect(app)).toBe(false);

  /**
   * ember-nvp writes the Vite config.
   */
  app.write("vite.config.mjs", VITE_CONFIG);

  expect(proxyPluginStage.detect(app)).toBe(true);

  await proxyPluginStage.run(app);

  expect(app.read("vite.config.mjs")).toMatchInlineSnapshot(`
    "import { defineConfig } from "vite";
    import { ember } from "@nullvoxpopuli/ember-vite";
    import emberServeProxy from "./server/proxy.mjs";

    export default defineConfig({
      plugins: [ember(), emberServeProxy()],
    });
    "
  `);
  expect(readProgress(app).map((entry) => entry.status)).toEqual(["moved"]);
  expect(proxyPluginStage.detect(app)).toBe(false);
});

test("the plugin sends what Vite does not serve to the backend of the script", async () => {
  let backend = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ host: req.headers.host, method: req.method, url: req.url }));
  });

  await new Promise((resolve) => backend.listen(0, "127.0.0.1", () => resolve(undefined)));

  let port = /** @type {import('node:net').AddressInfo} */ (backend.address()).port;
  let app = project({
    "package.json": {
      name: "app",
      scripts: { "start:local": `ember serve --proxy http://127.0.0.1:${port}/backend` },
    },
    "index.html": "<!doctype html><title>app</title>",
    "app/app.js": "export default 1;\n",
  });

  await proxyScriptsStage.run(app);

  let lifecycle = process.env.npm_lifecycle_event;

  process.env.npm_lifecycle_event = "start:local";

  let plugin = await import(pathToFileURL(join(app.directory, "server/proxy.mjs")).href);
  let vite = await createViteServer({
    root: app.directory,
    configFile: false,
    logLevel: "silent",
    server: { port: 0, host: "127.0.0.1" },
    plugins: [plugin.default()],
  });

  try {
    await vite.listen();

    let url = /** @type {string[]} */ (vite.resolvedUrls?.local)[0];
    let api = await fetch(new URL("api/v1/crates?page=2", url), {
      method: "POST",
      headers: { accept: "application/json" },
    });

    expect(await api.json()).toEqual({
      host: `127.0.0.1:${port}`,
      method: "POST",
      url: "/backend/api/v1/crates?page=2",
    });

    let page = await fetch(new URL("crates/ember", url), { headers: { accept: "text/html" } });

    expect(await page.text()).toContain("<title>app</title>");

    let module = await fetch(new URL("app/app.js", url));

    expect(await module.text()).toContain("export default 1");
  } finally {
    if (lifecycle === undefined) delete process.env.npm_lifecycle_event;
    else process.env.npm_lifecycle_event = lifecycle;
    await vite.close();
    backend.close();
  }
});
