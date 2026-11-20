/**
 * Writes src/stages/ember-source/blueprints.json: for each ember-source LTS,
 * the dependency ranges in the app blueprint of the same ember-cli version.
 *
 * The bundle must not need the network, so the table is in the repo.
 * Run it again when a new LTS is out: `node scripts/lts-blueprints.js`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every fourth minor is an LTS. 7.4 is the first 7.x release that ember.nvp supports and that becomes an LTS.
 */
const LTS = ["3.28", "4.4", "4.8", "4.12", "5.4", "5.8", "5.12", "6.4", "6.8", "6.12", "7.4"];

/**
 * @param {string} spec such as "ember-cli@4.12"
 * @returns {{ version: string, tarball: string }}
 */
function resolve(spec) {
  let json = execFileSync("npm", ["view", spec, "version", "dist.tarball", "--json"], {
    encoding: "utf8",
  });
  let data = JSON.parse(json);
  let last = Array.isArray(data) ? data[data.length - 1] : data;

  return { version: last.version, tarball: last["dist.tarball"] };
}

/**
 * @param {string} tarball
 * @param {string[]} candidates paths inside the package
 * @returns {Record<string, any> | undefined}
 */
function blueprintPackage(tarball, candidates) {
  let directory = mkdtempSync(join(tmpdir(), "lts-blueprint-"));

  try {
    execFileSync("sh", ["-c", `curl -sL "${tarball}" | tar xz -C "${directory}"`]);

    for (let candidate of candidates) {
      let source;

      try {
        source = readFileSync(join(directory, "package", candidate), "utf8");
      } catch {
        continue;
      }

      /**
       * The blueprint is an EJS template. Drop the template tags, so that the ranges read as JSON.
       */
      let json = source.replace(/<%[^%]*%>/g, "");
      /** @type {Record<string, string>} */
      let ranges = {};

      for (let match of json.matchAll(/"([@\w./-]+)":\s*"([~^]?\d[^"]*)"/g)) {
        ranges[match[1]] = match[2];
      }

      return ranges;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** @type {Record<string, Record<string, string>>} */
let table = {};

for (let lts of LTS) {
  let source = resolve(`ember-source@${lts}`);
  /**
   * Later ember-cli versions moved the app blueprint to @ember/app-blueprint.
   */
  let blueprint =
    blueprintPackage(resolve(`ember-cli@${lts}`).tarball, ["blueprints/app/files/package.json"]) ??
    blueprintPackage(resolve(`@ember/app-blueprint@${lts}`).tarball, ["files/package.json"]);

  if (!blueprint) throw new Error(`No app blueprint for ${lts}`);

  blueprint["ember-source"] = `~${source.version}`;

  /**
   * The classic blueprint writes the ember-cli range as a template value.
   */
  blueprint["ember-cli"] ??= `~${resolve(`ember-cli@${lts}`).version}`;

  /**
   * From 6.x the blueprint lists @warp-drive packages. Apps that still list ember-data get the same version.
   */
  if (!blueprint["ember-data"] && blueprint["@warp-drive/core"]) {
    blueprint["ember-data"] = blueprint["@warp-drive/core"];
  }

  table[lts] = blueprint;
  console.log(`${lts}: ember-source ${source.version}, ${Object.keys(blueprint).length} ranges`);
}

writeFileSync(
  new URL("../src/stages/ember-source/blueprints.json", import.meta.url),
  JSON.stringify(table, null, 2) + "\n",
);
