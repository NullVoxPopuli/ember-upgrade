import { copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "rolldown";

const require = createRequire(import.meta.url);

/**
 * oxc-parser loads a native binary per platform,
 * and a bundle cannot carry those.
 * The WASI build of the same parser runs on every platform.
 */
const binding = dirname(require.resolve("@oxc-parser/binding-wasm32-wasi/package.json"));
const fromEstree = createRequire(require.resolve("ember-estree"));
const oxcParser = dirname(fromEstree.resolve("oxc-parser/package.json"));
/**
 * content-tag does not export its package.json. Its main module is pkg/node.cjs.
 */
const contentTagWasm = join(dirname(fromEstree.resolve("content-tag")), "node/content_tag_bg.wasm");

/**
 * The binding pins its own @emnapi copies.
 * Without this, the bundle picks up whichever copy the install hoisted,
 * and the runtime refuses a mismatched pair.
 *
 * @param {string} name
 */
function emnapi(name) {
  /**
   * Node resolution from the binding's folder, by hand,
   * because @emnapi packages do not export their package.json.
   */
  for (let dir = binding; dir !== dirname(dir); dir = dirname(dir)) {
    let candidate = join(dir, "node_modules", name);

    if (existsSync(candidate)) return candidate;
  }

  throw new Error(`Cannot find ${name} from ${binding}`);
}

const alias = {
  "oxc-parser": join(oxcParser, "src-js/wasm.js"),
  "@emnapi/core": emnapi("@emnapi/core"),
  "@emnapi/runtime": emnapi("@emnapi/runtime"),
  "@emnapi/wasi-threads": emnapi("@emnapi/wasi-threads"),
};

/**
 * Both parsers read their .wasm from the folder of the module that loads them,
 * which is dist/ after bundling.
 *
 * @type {import('rolldown').Plugin}
 */
const copyWasm = {
  name: "copy-wasm",
  writeBundle() {
    copyFileSync(join(binding, "parser.wasm32-wasi.wasm"), "dist/parser.wasm32-wasi.wasm");
    copyFileSync(contentTagWasm, "dist/content_tag_bg.wasm");
  },
};

export default defineConfig([
  {
    input: { cli: "./src/cli.js" },
    platform: "node",
    resolve: { alias },
    plugins: [copyWasm],
    output: { dir: "dist", format: "esm", banner: "#!/usr/bin/env node" },
  },
  {
    /**
     * The WASI binding starts this file in a worker thread by path.
     */
    input: { "wasi-worker": join(binding, "wasi-worker.mjs") },
    platform: "node",
    resolve: { alias },
    output: { dir: "dist", format: "esm", entryFileNames: "[name].mjs" },
  },
]);
