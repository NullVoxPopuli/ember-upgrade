import { toTree } from "ember-estree";

import { parseProgram, walk } from "#ast.js";
import { removeBuildOptions } from "#config-files.js";
import { Edits } from "#edits.js";
import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */
/** @typedef {import('#ast.js').Node} Node */

const ADDON = "ember-leaflet";
const TEMPLATES = ["app/**/*.{hbs,gjs,gts}"];
const SCRIPTS = ["app/**/*.{js,ts,gjs,gts}"];
const APP_FILES = ["app/app.js", "app/app.ts"];
const MAP_MODULE = "ember-leaflet/components/leaflet-map";
const NEW_MODULE = "ember-maplibre-gl/components/maplibre-gl";
const CSS = "import 'maplibre-gl/dist/maplibre-gl.css';";

/**
 * The arguments of `<LeafletMap>` that are map options of MapLibre with the same name.
 */
const SAME_OPTIONS = new Set(["zoom", "minZoom", "maxZoom"]);

/**
 * A marker of ember-maplibre-gl is the block that it renders, so a marker that had only a popup gets the
 * pin that Leaflet drew. Its tip is the bottom of the element, like the default markers of Leaflet and MapLibre.
 */
const PIN =
  '<svg width="27" height="41" viewBox="0 0 27 41" aria-hidden="true">' +
  '<path fill="#3FB1CE" d="M13.5 0C6 0 0 6 0 13.5 0 23.6 13.5 41 13.5 41S27 23.6 27 13.5C27 6 21 0 13.5 0z" />' +
  '<circle fill="#fff" cx="13.5" cy="13.5" r="5.5" /></svg>';

/**
 * Leaflet fills `{s}` with one of its default subdomains.
 */
const SUBDOMAINS = ["a", "b", "c"];

const EMPTY_STYLE = "(hash version=8 sources=(hash) layers=(array))";

/**
 * @param {unknown} node
 * @param {(node: Node) => void} visit
 */
function walkAll(node, visit) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let child of node) walkAll(child, visit);
    return;
  }

  let astNode = /** @type {Node} */ (node);

  if (typeof astNode.type === "string") visit(astNode);

  for (let key in astNode) {
    if (key === "loc" || key === "range" || key === "parent" || key === "tokens") continue;

    walkAll(astNode[key], visit);
  }
}

/**
 * @param {string} source
 * @param {Node} attribute
 * @returns {string | undefined} the value as a template expression, such as `this.lat` or `"x"`
 */
function expression(source, attribute) {
  let value = attribute.value;

  if (value.type === "GlimmerTextNode") return JSON.stringify(value.chars);
  if (value.type === "GlimmerMustacheStatement")
    return source.slice(value.start + 2, value.end - 2).trim();
}

/**
 * @param {Node} element
 * @returns {number} where the opening tag ends
 */
function openTagEnd(element) {
  if (element.children.length > 0) return element.children[0].start;
  if (element.selfClosing) return element.end;

  return element.end - `</${element.tag}>`.length;
}

/**
 * @param {string} source
 * @param {Node} element
 * @returns {string} the attributes and modifiers that are not arguments, as written
 */
function plainAttributes(source, element) {
  return element.attributes
    .filter((/** @type {Node} */ attribute) => !attribute.name.startsWith("@"))
    .concat(element.modifiers)
    .sort((/** @type {Node} */ a, /** @type {Node} */ b) => a.start - b.start)
    .map((/** @type {Node} */ node) => ` ${source.slice(node.start, node.end)}`)
    .join("");
}

/**
 * @param {Node} element
 * @returns {Map<string, Node>} the arguments, by name without `@`
 */
function argsOf(element) {
  return new Map(
    element.attributes
      .filter((/** @type {Node} */ attribute) => attribute.name.startsWith("@"))
      .map((/** @type {Node} */ attribute) => [attribute.name.slice(1), attribute]),
  );
}

/**
 * @param {string} source
 * @param {Node} tile `<layers.tile @url=... />`
 * @param {string} layers
 * @param {string[]} unreadable
 * @returns {string | undefined}
 */
function tileSource(source, tile, layers, unreadable) {
  let args = argsOf(tile);
  let url = args.get("url");

  if (!url || url.value.type !== "GlimmerTextNode") {
    unreadable.push(`${layers}.tile needs a @url that is a string`);
    return;
  }

  for (let name of args.keys()) {
    if (name !== "url" && name !== "attribution") unreadable.push(`${layers}.tile @${name}`);
  }

  let template = String(url.value.chars);
  let tiles = template.includes("{s}")
    ? SUBDOMAINS.map((subdomain) => JSON.stringify(template.replace("{s}", subdomain)))
    : [JSON.stringify(template)];
  let attribution = args.get("attribution");
  let extra = attribution ? ` attribution=${expression(source, attribution)}` : "";

  return (
    `<${layers}.source @options={{hash type="raster" tiles=(array ${tiles.join(" ")}) tileSize=256${extra}}} as |tileSource|>` +
    `<tileSource.layer @options={{hash type="raster"}} /></${layers}.source>`
  );
}

/**
 * Turns each `<LeafletMap>` into `<MapLibreGL>`, with its tile layers as raster sources and its markers with `@lngLat`.
 *
 * @param {string} source a template, or a .gjs or .gts module
 * @param {string} file
 * @param {string} tag the name that calls the map, such as `LeafletMap`
 * @param {string} newTag such as `MapLibreGL`
 * @returns {{ output: string, unreadable: string[], maps: number }}
 */
export function convertMaps(source, file, tag, newTag) {
  let hbs = file.endsWith(".hbs");
  let text = hbs ? `<template>${source}</template>` : source;
  let tree = toTree(text, { filePath: hbs ? "template.gjs" : file });
  let edits = new Edits(text);
  /** @type {string[]} */
  let unreadable = [];
  let maps = 0;

  walkAll(tree, (map) => {
    if (map.type !== "GlimmerElementNode" || map.tag !== tag) return;

    maps++;

    let layers = map.blockParams?.[0];
    let args = argsOf(map);
    /** @type {string[]} */
    let options = [`style=${EMPTY_STYLE}`];
    let lat = args.get("lat");
    let lng = args.get("lng");

    if (lat && lng)
      options.push(`center=(array ${expression(text, lng)} ${expression(text, lat)})`);
    else if (lat || lng || args.has("center")) unreadable.push(`${tag} needs @lat and @lng`);

    for (let [name, attribute] of args) {
      if (name === "lat" || name === "lng" || name === "class") continue;

      let value = expression(text, attribute);

      if (SAME_OPTIONS.has(name) && value !== undefined) options.push(`${name}=${value}`);
      else unreadable.push(`${tag} @${name}`);
    }

    let className = args.get("class");
    let classAttribute = className
      ? ` class=${className.value.type === "GlimmerTextNode" ? JSON.stringify(className.value.chars) : text.slice(className.value.start, className.value.end)}`
      : "";
    let params = layers ? ` as |${layers}|` : "";

    edits.replace(
      { start: map.start, end: openTagEnd(map) },
      `<${newTag}${classAttribute}${plainAttributes(text, map)} @initOptions={{hash ${options.join(" ")}}}${params}>`,
    );

    if (!map.selfClosing) {
      edits.replace({ start: map.end - `</${tag}>`.length, end: map.end }, `</${newTag}>`);
    }

    walkAll(map.children, (child) => {
      if (child.type !== "GlimmerElementNode" || !layers || !child.tag.startsWith(`${layers}.`))
        return;

      let kind = child.tag.slice(layers.length + 1);

      if (kind === "tile") {
        let replacement = tileSource(text, child, layers, unreadable);

        if (replacement) edits.replace(child, replacement);
        return;
      }

      if (kind !== "marker") {
        unreadable.push(`${child.tag}`);
        return;
      }

      let markerArgs = argsOf(child);
      let markerLat = markerArgs.get("lat");
      let markerLng = markerArgs.get("lng");

      for (let name of markerArgs.keys()) {
        if (name !== "lat" && name !== "lng") unreadable.push(`${child.tag} @${name}`);
      }

      if (!markerLat || !markerLng) {
        unreadable.push(`${child.tag} needs @lat and @lng`);
        return;
      }

      let marker = child.blockParams?.[0];

      walkAll(child.children, (inner) => {
        if (inner.type !== "GlimmerElementNode" || !marker || !inner.tag.startsWith(`${marker}.`))
          return;
        if (inner.tag !== `${marker}.popup` || argsOf(inner).size > 0) unreadable.push(inner.tag);
      });

      let open =
        `<${child.tag}${plainAttributes(text, child)} @lngLat={{array ${expression(text, markerLng)} ${expression(text, markerLat)}}}` +
        ` @initOptions={{hash anchor="bottom"}}${marker ? ` as |${marker}|` : ""}>${PIN}`;

      if (child.selfClosing) {
        edits.replace(child, `${open}</${child.tag}>`);
      } else {
        edits.replace({ start: child.start, end: openTagEnd(child) }, open);
      }
    });
  });

  if (maps === 0 || unreadable.length > 0) return { output: source, unreadable, maps };

  let output = edits.apply();

  return {
    output: hbs ? output.slice("<template>".length, -"</template>".length) : output,
    unreadable,
    maps,
  };
}

/**
 * @param {string} source a .gjs or .gts module
 * @param {string} file
 * @returns {{ output: string, tag: string } | undefined} the module with the import of MapLibreGL and the helpers that the map needs
 */
export function convertImports(source, file) {
  let program = parseProgram(source, file);
  let declaration = program?.body.find(
    (/** @type {Node} */ node) =>
      node.type === "ImportDeclaration" && node.source.value === MAP_MODULE,
  );
  let specifier = declaration?.specifiers.find(
    (/** @type {Node} */ node) => node.type === "ImportDefaultSpecifier",
  );

  if (!program || !declaration || !specifier) return;

  let edits = new Edits(source);
  let helpers = program.body.find(
    (/** @type {Node} */ node) =>
      node.type === "ImportDeclaration" && node.source.value === "@ember/helper",
  );
  let present = new Set(
    (helpers?.specifiers ?? []).map((/** @type {Node} */ node) => node.imported?.name),
  );
  let missing = ["array", "hash"].filter((name) => !present.has(name));
  let lines = [`import MapLibreGL from '${NEW_MODULE}';`];

  if (missing.length > 0 && !helpers)
    lines.push(`import { ${missing.join(", ")} } from '@ember/helper';`);

  edits.replace(declaration, lines.join("\n"));

  if (missing.length > 0 && helpers) {
    let last = helpers.specifiers[helpers.specifiers.length - 1];

    edits.insert(last.end, `, ${missing.join(", ")}`);
  }

  /**
   * A comment that silenced the types of the old import has nothing to silence now.
   */
  let lineStart = source.lastIndexOf("\n", declaration.start - 1) + 1;
  let previousStart = source.lastIndexOf("\n", lineStart - 2) + 1;
  let previous = source.slice(previousStart, lineStart - 1);

  if (previous.trim().startsWith("// @ts-expect-error")) {
    edits.removeLine({ start: previousStart + previous.indexOf("//"), end: lineStart - 1 });
  }

  return { output: edits.apply(), tag: specifier.local.name };
}

/**
 * @param {Node} node
 * @returns {boolean} the node sets an option of `L.Icon.Default`, such as `L.Icon.Default.imagePath = ...`
 */
function setsDefaultIcon(node) {
  if (node.type !== "ExpressionStatement" || node.expression.type !== "AssignmentExpression") {
    return false;
  }

  /** @type {string[]} */
  let path = [];
  let target = node.expression.left;

  while (target.type === "MemberExpression" && !target.computed) {
    path.unshift(target.property.name);
    target = target.object;
  }

  return (
    target.type === "Identifier" &&
    target.name === "L" &&
    path[0] === "Icon" &&
    path[1] === "Default"
  );
}

/**
 * @param {string} source
 * @param {Node} node
 * @returns {{ start: number, end: number }} the node with the `//` comment lines right above it
 */
function withCommentsAbove(source, node) {
  let start = node.start;

  for (;;) {
    let lineStart = source.lastIndexOf("\n", start - 1) + 1;
    let previousStart = source.lastIndexOf("\n", lineStart - 2) + 1;

    if (lineStart === 0 || !source.slice(previousStart, lineStart).trim().startsWith("//")) break;

    start = previousStart + source.slice(previousStart, lineStart).indexOf("//");
  }

  return { start, end: node.end };
}

/**
 * The marker icons of Leaflet are images, and the MapLibre markers of the stage draw a pin.
 * So the settings of `L.Icon.Default` go, with the constants that only they read.
 *
 * @param {string} source
 * @param {Node} callback the function that runs after the load
 * @param {Edits} edits
 * @returns {boolean} true when the callback reads the `L` global in another way
 */
function removeIconSettings(source, callback, edits) {
  if (callback?.body?.type !== "BlockStatement") return false;

  let statements = callback.body.body;
  let removed = new Set(statements.filter(setsDefaultIcon));

  for (let changed = removed.size > 0; changed;) {
    changed = false;

    for (let statement of statements) {
      if (removed.has(statement) || statement.type !== "VariableDeclaration") continue;

      let names = statement.declarations.map(
        (/** @type {Node} */ declarator) => declarator.id.name,
      );
      let rest = statements
        .filter((/** @type {Node} */ other) => other !== statement && !removed.has(other))
        .map((/** @type {Node} */ other) => source.slice(other.start, other.end))
        .join("\n");

      if (names.every((name) => name && !new RegExp(`\\b${name}\\b`).test(rest))) {
        removed.add(statement);
        changed = true;
      }
    }
  }

  for (let statement of removed) edits.removeLine(withCommentsAbove(source, statement));

  return statements.some(
    (/** @type {Node} */ statement) =>
      !removed.has(statement) && /\bL\./.test(source.slice(statement.start, statement.end)),
  );
}

/**
 * @param {string} source
 * @param {string} file
 * @returns {{ output: string, unreadable: string[] }} the module with `import('maplibre-gl')` for each `import('leaflet')` that only loads it
 */
export function convertLoads(source, file) {
  let program = parseProgram(source, file);
  let edits = new Edits(source);
  /** @type {string[]} */
  let unreadable = [];

  /**
   * The `.then()` call of each `import('leaflet').then`, by its member expression
   *
   * @type {Map<Node, Node>}
   */
  let callbacks = new Map();

  walk(program, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
      callbacks.set(node.callee, node);
    }
  });

  walk(program, (node, parent) => {
    if (node.type === "ImportDeclaration" && /^leaflet(\/|$)/.test(String(node.source.value))) {
      if (/\.css$/.test(String(node.source.value))) edits.removeLine(node);
      else unreadable.push(`import from '${node.source.value}'`);
    }

    if (node.type !== "ImportExpression" || node.source.value !== "leaflet") return;

    /**
     * Only a load whose result nothing reads, such as `import('leaflet').then(() => ...)`, has the same meaning.
     */
    let then = parent?.type === "MemberExpression" && parent.property.name === "then";

    if (then || parent?.type === "ExpressionStatement" || parent?.type === "UnaryExpression") {
      edits.replace(node.source, `'maplibre-gl'`);

      if (then && removeIconSettings(source, callbacks.get(parent)?.arguments[0], edits)) {
        unreadable.push("the Leaflet global `L`, after import('leaflet')");
      }
    } else {
      unreadable.push("import('leaflet') whose result the code reads");
    }
  });

  return { output: edits.apply(), unreadable };
}

/**
 * @param {Project} project
 * @returns {{ file: string, output: string, unreadable: string[] }[]} each file that changes, or that the stage cannot change
 */
function plan(project) {
  /** @type {Map<string, { output: string, unreadable: string[] }>} */
  let files = new Map();

  for (let file of project.files(TEMPLATES)) {
    let source = project.read(file);

    if (!/LeafletMap|leaflet-map/.test(source)) continue;

    let output = source;
    let tag = "LeafletMap";
    /** @type {string[]} */
    let unreadable = [];

    if (!file.endsWith(".hbs")) {
      let imports = convertImports(source, file);

      if (!imports) continue;

      output = imports.output;
      tag = imports.tag;
    }

    if (/\{\{#?leaflet-map\b/.test(output)) unreadable.push("{{leaflet-map}}");

    let maps = convertMaps(output, file, tag, file.endsWith(".hbs") ? "MaplibreGl" : "MapLibreGL");

    files.set(file, { output: maps.output, unreadable: unreadable.concat(maps.unreadable) });
  }

  for (let file of project.files(SCRIPTS)) {
    let source = files.get(file)?.output ?? project.read(file);

    if (!source.includes("leaflet")) continue;

    let loads = convertLoads(source, file);

    if (loads.output === source && loads.unreadable.length === 0) continue;

    let previous = files.get(file);

    files.set(file, {
      output: loads.output,
      unreadable: (previous?.unreadable ?? []).concat(loads.unreadable),
    });
  }

  return Array.from(files, ([file, result]) => Object.assign({ file }, result));
}

/**
 * ember-leaflet is a v1 addon with no v2 release, and its templates do not build with ember-source 6.
 * ember-maplibre-gl is a v2 addon for the same maps, on MapLibre.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: ADDON,
  label: "Replace ember-leaflet with ember-maplibre-gl",

  detect(project) {
    return Boolean(project.dependency(ADDON));
  },

  async check(project) {
    /** @type {import('#types.js').Report} */
    let report = { blockers: [], todo: [] };

    for (let { file, unreadable } of plan(project)) {
      if (unreadable.length === 0) continue;

      report.blockers.push({
        title: `Leaflet code that the stage cannot move to ember-maplibre-gl: ${unreadable.join(", ")}`,
        where: [file],
        action: "Move it by hand, or remove it, then run ember-upgrade again.",
      });
    }

    return report;
  },

  async run(project) {
    for (let { file, output } of plan(project)) {
      if (output !== project.read(file)) project.write(file, output);
    }

    let app = APP_FILES.find((file) => project.has(file));

    if (app && !project.read(app).includes("maplibre-gl.css")) {
      let source = project.read(app);
      let program = parseProgram(source, app);
      let imports = (program?.body ?? []).filter(
        (/** @type {Node} */ node) => node.type === "ImportDeclaration",
      );
      let last = imports[imports.length - 1];
      let edits = new Edits(source);

      if (last) edits.insert(last.end, `\n${CSS}`);
      else edits.insert(0, `${CSS}\n`);

      project.write(app, edits.apply());
    }

    removeBuildOptions(project, [ADDON]);
    editPackageJson(project, (pkg) => {
      removeDependency(pkg, ADDON);
      removeDependency(pkg, "leaflet");
      setDependency(
        pkg,
        "ember-maplibre-gl",
        `^${published("ember-maplibre-gl")?.version ?? "0.9.0"}`,
      );
      setDependency(pkg, "maplibre-gl", `^${published("maplibre-gl")?.version ?? "6.19.0"}`);
    });

    recordProgress(project, {
      id: ADDON,
      status: "replaced",
      note:
        "ember-leaflet is replaced with ember-maplibre-gl. Tile layers are raster sources, and markers have a pin like Leaflet's. " +
        "MapLibre counts zoom levels for 512 px tiles, so a map of 256 px tiles at the same zoom shows a smaller area. " +
        "Check the zoom of each map.",
      links: ["https://github.com/johanrd/ember-maplibre-gl"],
    });

    return [];
  },
};
