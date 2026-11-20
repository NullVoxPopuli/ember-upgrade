import mappings from "ember-rfc176-data/mappings.json" with { type: "json" };

/**
 * @typedef {object} ModuleExport
 * @property {string} module
 * @property {string} export "default" or a named export
 * @property {string} localName the name to import it as
 */

/**
 * @param {string} global for example "Ember.computed.alias"
 * @param {string} exportName
 * @param {string | undefined} localName
 */
function nameFor(global, exportName, localName) {
  if (localName) return localName;

  /**
   * The last segment keeps the name that the code used before:
   * `Ember.inject.service` becomes `inject as service`.
   */
  return global.slice(global.lastIndexOf(".") + 1);
}

/**
 * RFC 176 globals, keyed by the global path.
 *
 * A deprecated entry names an old shim module.
 * Its replacement is the module to import from.
 *
 * @type {Map<string, ModuleExport>}
 */
export const GLOBALS = new Map();

for (let entry of mappings) {
  if (entry.deprecated) continue;

  GLOBALS.set(entry.global, {
    module: entry.module,
    export: entry.export,
    localName: nameFor(entry.global, entry.export, entry.localName),
  });
}

for (let entry of mappings) {
  if (!entry.deprecated || !entry.replacement || GLOBALS.has(entry.global)) continue;

  GLOBALS.set(entry.global, {
    module: entry.replacement.module,
    export: entry.replacement.export,
    localName: nameFor(entry.global, entry.replacement.export, entry.localName),
  });
}
