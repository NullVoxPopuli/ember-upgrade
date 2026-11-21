import { dirname, join, relative } from "node:path";

/**
 * A statement at the top level of a stylesheet.
 *
 * @typedef {object} Statement
 * @property {string} prelude the text before `{` or `;`
 * @property {number} start
 * @property {number} end
 * @property {number} [bodyStart] after the `{` of a block
 * @property {number} [bodyEnd] at the `}` of a block
 */

/**
 * @param {string} source
 * @param {number} index at a quote
 * @returns {number} after the closing quote
 */
function skipString(source, index) {
  let quote = source[index];
  let i = index + 1;

  while (i < source.length && source[i] !== quote) {
    if (source[i] === "\\") i++;
    i++;
  }

  return i + 1;
}

/**
 * @param {string} source
 * @param {number} index
 * @param {boolean} scss `//` starts a comment in SCSS, but not in CSS, where it can be in a URL
 * @returns {number | undefined} after the comment, when a comment starts at `index`
 */
function skipComment(source, index, scss) {
  if (source.startsWith("/*", index)) {
    let end = source.indexOf("*/", index + 2);

    return end === -1 ? source.length : end + 2;
  }

  if (scss && source.startsWith("//", index) && source[index - 1] !== ":") {
    let end = source.indexOf("\n", index);

    return end === -1 ? source.length : end;
  }
}

/**
 * @param {string} source
 * @param {number} open at a `{`
 * @param {boolean} scss
 * @returns {number} at the matching `}`
 */
export function matchBrace(source, open, scss) {
  let depth = 0;
  let i = open;

  while (i < source.length) {
    let comment = skipComment(source, i, scss);

    if (comment !== undefined) {
      i = comment;
      continue;
    }

    let char = source[i];

    if (char === '"' || char === "'") {
      i = skipString(source, i);
      continue;
    }

    if (char === "{") depth++;

    if (char === "}") {
      depth--;
      if (depth === 0) return i;
    }

    i++;
  }

  return source.length;
}

/**
 * Splits a stylesheet into its top-level statements. Comments are left out.
 *
 * @param {string} source
 * @param {boolean} scss
 * @returns {Statement[]}
 */
export function topLevel(source, scss) {
  /** @type {Statement[]} */
  let statements = [];
  let i = 0;
  let start = -1;

  while (i < source.length) {
    let comment = skipComment(source, i, scss);

    if (comment !== undefined) {
      i = comment;
      continue;
    }

    let char = source[i];

    if (start === -1 && /\s/.test(char)) {
      i++;
      continue;
    }

    if (start === -1) start = i;

    if (char === '"' || char === "'") {
      i = skipString(source, i);
      continue;
    }

    /**
     * `#{...}` is SCSS interpolation, not a block.
     */
    if (char === "{" && source[i - 1] === "#") {
      i = matchBrace(source, i, scss) + 1;
      continue;
    }

    if (char === ";") {
      statements.push({ prelude: source.slice(start, i).trim(), start, end: i + 1 });
      start = -1;
    } else if (char === "{") {
      let close = matchBrace(source, i, scss);

      statements.push({
        prelude: source.slice(start, i).trim(),
        start,
        end: close + 1,
        bodyStart: i + 1,
        bodyEnd: close,
      });
      start = -1;
      i = close;
    }

    i++;
  }

  if (start !== -1 && source.slice(start).trim()) {
    statements.push({ prelude: source.slice(start).trim(), start, end: source.length });
  }

  return statements;
}

/**
 * Replaces `:global(.a)` with `.a`, and removes a bare `:global ` prefix.
 * Files that ember-scoped-css does not read are global, so the marker has no meaning there.
 *
 * @param {string} source
 * @returns {string}
 */
export function unwrapGlobal(source) {
  let output = "";
  let i = 0;

  for (;;) {
    let found = source.indexOf(":global", i);

    if (found === -1) return output + source.slice(i);

    output += source.slice(i, found);
    i = found + ":global".length;

    if (source[i] === "(") {
      let depth = 0;
      let j = i;

      for (; j < source.length; j++) {
        if (source[j] === "(") depth++;
        if (source[j] === ")" && --depth === 0) break;
      }

      output += source.slice(i + 1, j);
      i = j + 1;
    } else {
      i += source.slice(i).match(/^\s*/)?.[0].length ?? 0;
    }
  }
}

/**
 * @param {string} prelude such as `@import 'a', "b"`
 * @returns {string[] | undefined} the paths, or undefined for a CSS import such as `url(...)`
 */
export function importPaths(prelude) {
  if (!/^@import\s/.test(prelude)) return;

  let rest = prelude.slice("@import".length).trim();
  let paths = [];

  for (let part of rest.split(",")) {
    let match = part.trim().match(/^(['"])(.*)\1$/);

    if (!match) return;

    paths.push(match[2]);
  }

  return paths;
}

/**
 * Finds the file that Sass loads for `@import`.
 *
 * @param {(file: string) => boolean} has
 * @param {string} spec
 * @param {string[]} bases folders to look in, relative to the project
 * @returns {string | undefined} the file, relative to the project
 */
export function resolveSass(has, spec, bases) {
  if (/^(https?:|url\()/.test(spec) || spec.endsWith(".css")) return;

  for (let base of bases) {
    let path = join(base, spec);
    let partial = join(dirname(path), `_${path.slice(dirname(path).length + 1)}`);
    let candidates = [path, partial, join(path, "_index"), join(path, "index")];

    for (let candidate of candidates) {
      for (let ext of ["", ".scss", ".sass", ".css"]) {
        let file = candidate + ext;

        if (/\.(scss|sass|css)$/.test(file) && has(file)) return file;
      }
    }
  }
}

/**
 * The path to put in `@import`, relative to the folder of the importer.
 *
 * @param {string} from the folder of the importer
 * @param {string} file
 * @returns {string}
 */
export function importPath(from, file) {
  let path = relative(from, file).replace(/\\/g, "/");
  let slash = path.lastIndexOf("/");
  let name = path
    .slice(slash + 1)
    .replace(/^_/, "")
    .replace(/\.(scss|sass)$/, "");
  let folder = path.slice(0, slash + 1);

  return folder.startsWith(".") ? folder + name : `./${folder}${name}`;
}

/**
 * True when the stylesheet only defines variables, mixins, functions, and placeholders.
 * Such a file can be imported by each component, because it adds no CSS to the output.
 *
 * @param {(file: string) => boolean} has
 * @param {(file: string) => string} read
 * @param {string} file
 * @param {string[]} loadPaths
 * @param {Set<string>} [seen]
 * @returns {boolean}
 */
export function definitionsOnly(has, read, file, loadPaths, seen = new Set()) {
  if (seen.has(file)) return true;

  seen.add(file);

  for (let statement of topLevel(read(file), true)) {
    let { prelude } = statement;

    if (statement.bodyStart === undefined) {
      if (/^\$[\w-]+\s*:/.test(prelude) || /^@(use|forward|charset)\b/.test(prelude)) continue;

      let paths = importPaths(prelude);

      if (!paths) return false;

      for (let spec of paths) {
        let resolved = resolveSass(has, spec, [dirname(file)].concat(loadPaths));

        if (!resolved || !definitionsOnly(has, read, resolved, loadPaths, seen)) return false;
      }
    } else if (!/^(@mixin|@function|%)/.test(prelude)) {
      return false;
    }
  }

  return true;
}

/**
 * The variables, mixins, functions, and placeholders that the stylesheet defines at the top level.
 *
 * @param {string} source
 * @returns {RegExp[]} one pattern for each name, that matches where a stylesheet uses it
 */
export function definitions(source) {
  /** @type {RegExp[]} */
  let found = [];

  for (let { prelude } of topLevel(source, true)) {
    let match = prelude.match(/^(\$|@mixin\s+|@function\s+|%)([\w-]+)/);

    if (!match) continue;

    let name = match[2];
    let kind = match[1].trim();
    let use =
      kind === "$"
        ? `\\$${name}(?![\\w-])`
        : kind === "@mixin"
          ? `@include\\s+${name}(?![\\w-])`
          : kind === "%"
            ? `%${name}(?![\\w-])`
            : `(?<![\\w-])${name}\\(`;

    found.push(new RegExp(use));
  }

  return found;
}

/**
 * Changes `:global .a .b` to `:global(.a) :global(.b)`.
 * ember-css-modules reads the bare form, but ember-scoped-css reads only the form with parentheses.
 *
 * @param {string} source
 * @returns {string}
 */
export function wrapBareGlobal(source) {
  return source.replace(/:global(?!\()\s+([^{},;]+?)(\s*)(?=[{,])/g, (_, selector, space) => {
    let parts = selector
      .split(/\s+/)
      .map((/** @type {string} */ part) => (/^[>+~]$/.test(part) ? part : `:global(${part})`));

    return parts.join(" ") + space;
  });
}

/**
 * @typedef {object} Composition
 * @property {string[]} names
 * @property {string | undefined} from a path, `global`, or undefined for the same file
 * @property {number} start
 * @property {number} end
 */

/**
 * Finds `composes:` declarations.
 *
 * @param {string} source
 * @returns {Composition[]}
 */
export function compositions(source) {
  /** @type {Composition[]} */
  let found = [];
  let pattern = /composes\s*:\s*([^;{}]+?)\s*(;|(?=\}))/g;

  for (let match of source.matchAll(pattern)) {
    let before = source[match.index - 1];

    if (before && !/[\s;{]/.test(before)) continue;

    let value = match[1].trim();
    let from = value.match(/\s+from\s+(?:(['"])(.*)\1|(global))$/);
    let names = (from ? value.slice(0, from.index) : value).split(/\s+/).filter(Boolean);

    found.push({
      names,
      from: from ? (from[2] ?? from[3]) : undefined,
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return found;
}

/**
 * The bodies of the top-level rules whose selector is exactly `.name`.
 *
 * @param {string} source
 * @param {string} name
 * @param {boolean} scss
 * @returns {string[]}
 */
export function classBodies(source, name, scss) {
  return topLevel(source, scss)
    .filter((statement) => statement.bodyStart !== undefined && statement.prelude === `.${name}`)
    .map((statement) => source.slice(statement.bodyStart, statement.bodyEnd));
}

/**
 * @param {string} body the inside of a rule
 * @param {string} indent
 * @returns {string} the declarations, one for each line, with the indentation of the composes declaration
 */
export function reindent(body, indent) {
  let lines = body.split("\n").filter((line) => line.trim() !== "");
  let common = lines.reduce(
    (min, line) => Math.min(min, line.match(/^\s*/)?.[0].length ?? 0),
    Infinity,
  );

  return lines
    .map((line, index) => (index === 0 ? "" : indent) + line.slice(common))
    .join("\n")
    .trim();
}
