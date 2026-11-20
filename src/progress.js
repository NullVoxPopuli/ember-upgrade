/**
 * The file in the upgraded project that lists the workarounds and the open work.
 * Each entry links the issues and pull requests that let the workaround go away.
 */
export const PROGRESS_FILE = "ember-upgrade-progress.yaml";

const HEADER = `# ember-upgrade writes this file.
# Each entry is a workaround to undo later, or work that ember-upgrade left for you.
# Remove an entry when its work is done.
`;

/**
 * @typedef {object} ProgressEntry
 * @property {string} id one entry for each id, usually the package name
 * @property {string} status such as "git-ref", "removed", or "v1-addon"
 * @property {string} note
 * @property {string[]} [links]
 */

/**
 * Reads the format that `write` makes. Strings are JSON strings, which YAML reads the same way.
 *
 * @param {string} source
 * @returns {ProgressEntry[]}
 */
export function parseProgress(source) {
  /** @type {ProgressEntry[]} */
  let entries = [];
  /** @type {Record<string, any> | undefined} */
  let entry;

  for (let line of source.split("\n")) {
    let item = line.match(/^ {2}- id: (.*)$/);
    let field = line.match(/^ {4}(\w+): (.+)$/);
    let link = line.match(/^ {6}- (.*)$/);

    if (item) {
      entry = { id: JSON.parse(item[1]), status: "", note: "" };
      entries.push(/** @type {ProgressEntry} */ (entry));
    } else if (entry && field) {
      entry[field[1]] = JSON.parse(field[2]);
    } else if (entry && link) {
      entry.links = (entry.links ?? []).concat(JSON.parse(link[1]));
    }
  }

  return entries;
}

/**
 * @param {ProgressEntry[]} entries
 * @returns {string}
 */
export function printProgress(entries) {
  let lines = [HEADER + "entries:"];

  for (let entry of entries) {
    lines.push(`  - id: ${JSON.stringify(entry.id)}`);
    lines.push(`    status: ${JSON.stringify(entry.status)}`);
    lines.push(`    note: ${JSON.stringify(entry.note)}`);

    if (entry.links?.length) {
      lines.push("    links:");

      for (let link of entry.links) lines.push(`      - ${JSON.stringify(link)}`);
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * @param {import('#project.js').Project} project
 * @returns {ProgressEntry[]}
 */
export function readProgress(project) {
  return project.has(PROGRESS_FILE) ? parseProgress(project.read(PROGRESS_FILE)) : [];
}

/**
 * Adds the entry, or replaces the entry with the same id.
 *
 * @param {import('#project.js').Project} project
 * @param {ProgressEntry} entry
 */
export function recordProgress(project, entry) {
  let entries = readProgress(project).filter((existing) => existing.id !== entry.id);

  entries.push(entry);
  project.write(PROGRESS_FILE, printProgress(entries));
}
