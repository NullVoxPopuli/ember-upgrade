/**
 * The Vite plugin that the static-site-json stage writes into the app.
 * It runs the Markdown and table-of-contents filters of broccoli-static-site-json itself,
 * so the JSON is the same as the ember-cli build wrote.
 */
export const PLUGIN_SOURCE = `import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const MarkdownToJsonApi = require("broccoli-static-site-json/lib/markdown-to-jsonapi");
const TableOfContents = require("broccoli-static-site-json/lib/table-of-contents");

const MARKDOWN = /\\.(md|markdown)$/;
const TOC = /(^|\\/)(pages|toc)\\.(yml|yaml|json)$/;

/**
 * The options of \`new StaticSiteJson(folder, options)\` from broccoli-static-site-json.
 *
 * @param {string} folder
 * @param {Record<string, any>} [options]
 */
export function StaticSiteJson(folder, options = {}) {
  return { folder, options };
}

/**
 * @param {string} folder
 * @returns {string[]} the files under the folder, relative to it, in the order of walk-sync
 */
function filesIn(folder) {
  /** @type {string[]} */
  let found = [];

  for (let name of readdirSync(folder).sort()) {
    let path = join(folder, name);

    if (statSync(path).isDirectory()) {
      for (let file of filesIn(path)) found.push(\`\${name}/\${file}\`);
    } else {
      found.push(name);
    }
  }

  return found;
}

/**
 * @param {Record<string, any>} options
 * @param {any[]} blobs
 * @param {Map<string, string>} files
 * @param {string} contentFolder
 */
function collate(options, blobs, files, contentFolder) {
  let name = options.collationFileName ?? "all.json";

  if (!options.paginate) {
    files.set(\`\${contentFolder}/\${name}\`, JSON.stringify({ data: blobs.map((blob) => blob.data) }));
    return;
  }

  let size = options.pageSize ?? 10;
  let sorted = options.paginateSortFunction ? blobs.slice().sort(options.paginateSortFunction) : blobs;
  let base = name.replace(/\\.json$/, "");
  let count = Math.ceil(sorted.length / size);

  for (let index = 0; index < count; index++) {
    let page = {
      data: sorted.slice(index * size, (index + 1) * size).map((blob) => blob.data),
      links: {
        first: \`/\${options.contentFolder}/\${base}-0.json\`,
        last: \`/\${options.contentFolder}/\${base}-\${count - 1}.json\`,
        prev: index === 0 ? null : \`/\${options.contentFolder}/\${base}-\${index - 1}.json\`,
        next: index === count - 1 ? null : \`/\${options.contentFolder}/\${base}-\${index + 1}.json\`,
      },
    };

    files.set(\`\${contentFolder}/\${base}-\${index}.json\`, JSON.stringify(page));

    if (index === 0) files.set(\`\${contentFolder}/\${name}\`, JSON.stringify(page));
  }
}

/**
 * @param {string} root
 * @param {{ folder: string, options: Record<string, any> }[]} trees
 * @returns {Map<string, string>} each JSON file, by its path in the build output
 */
function build(root, trees) {
  /** @type {Map<string, string>} */
  let files = new Map();

  for (let { folder, options } of trees) {
    let source = resolve(root, folder);

    if (!existsSync(source)) continue;

    /**
     * Vite takes output paths without a leading slash, and the dev server strips it from the URL.
     */
    let contentFolder = (options.contentFolder || "content").replace(/^\\/+/, "");
    let markdown = new MarkdownToJsonApi(source, options);
    let toc = new TableOfContents(source, options);
    let blobs = [];

    for (let file of filesIn(source)) {
      let text = readFileSync(join(source, file), "utf8");

      if (MARKDOWN.test(file)) {
        let json = markdown.processString(text, file);

        files.set(\`\${contentFolder}/\${file.replace(MARKDOWN, "")}.json\`, json);
        blobs.push(JSON.parse(json));
      } else if (TOC.test(file)) {
        let json = toc.processString(text, file);

        if (json) files.set(\`\${contentFolder}/\${file.replace(/\\.(yml|yaml|json)$/, "")}.json\`, json);
      }
    }

    if (options.collate) collate(options, blobs, files, contentFolder);
  }

  return files;
}

/**
 * Writes the JSON files that broccoli-static-site-json added to the public folder of the ember-cli build,
 * and serves them in the dev server.
 *
 * @param {{ folder: string, options: Record<string, any> }[]} trees
 * @returns {import("vite").Plugin}
 */
export function staticSiteJson(trees) {
  let root = process.cwd();

  return {
    name: "static-site-json",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      for (let { folder } of trees) server.watcher.add(resolve(root, folder));

      server.middlewares.use((request, response, next) => {
        let path = decodeURIComponent((request.url ?? "").split("?")[0]).replace(/^\\//, "");
        let json = build(root, trees).get(path);

        if (json === undefined) return next();

        response.setHeader("Content-Type", "application/json");
        response.end(json);
      });
    },
    generateBundle() {
      for (let [fileName, source] of build(root, trees)) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
  };
}

export default staticSiteJson;
`;

/**
 * The path that the app imports the plugin from.
 */
export const PLUGIN_FILE = "vite/static-site-json.mjs";
