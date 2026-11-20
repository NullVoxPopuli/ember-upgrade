/**
 * @param {string | undefined} range a dependency range, for example "~3.28.0" or "^5.4.1"
 * @returns {[number, number] | undefined} the lowest major and minor that the range allows
 */
export function minorOf(range) {
  let match = range?.match(/(\d+)\.(\d+)/);

  if (!match) return;

  return [Number(match[1]), Number(match[2])];
}

/**
 * @param {string | undefined} range
 * @param {number} major
 * @param {number} minor
 * @returns {boolean} false also when the range cannot be read
 */
export function atLeast(range, major, minor) {
  let version = minorOf(range);

  if (!version) return false;

  return version[0] > major || (version[0] === major && version[1] >= minor);
}
