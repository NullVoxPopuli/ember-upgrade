/**
 * The parsers run on node:wasi, and Node marks it experimental.
 * Users cannot act on that warning, so hide it and keep every other warning.
 *
 * cli.js imports this module first, so it runs before the parsers load.
 */
const emitWarning = process.emitWarning;

/** @type {typeof process.emitWarning} */
const quiet = function (/** @type {string | Error} */ warning, /** @type {any[]} */ ...rest) {
  if (String(warning).includes("WASI")) return;

  Reflect.apply(emitWarning, process, [warning].concat(rest));
};

process.emitWarning = quiet;
