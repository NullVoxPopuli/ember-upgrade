/**
 * Something the user must know about the project.
 *
 * @typedef {object} Finding
 * @property {string} title what was found
 * @property {string[]} [where] files, with a line when one is known
 * @property {string} [action] what the user can do about it
 */

/**
 * @typedef {object} Report
 * @property {Finding[]} blockers the stage cannot run until these are fixed
 * @property {Finding[]} todo the stage can run, and leaves these for the user
 */

/**
 * One step of the upgrade.
 *
 * A stage is done when `detect` returns false.
 * So a run that stopped can start again, and continue where it stopped.
 *
 * @typedef {object} Stage
 * @property {string} name the id for `--only` and `--from`
 * @property {string} label
 * @property {boolean} [needsInstall] the stage reads node_modules
 * @property {(project: import('#project.js').Project) => boolean} detect
 * @property {(project: import('#project.js').Project) => Promise<Report>} check changes nothing
 * @property {(project: import('#project.js').Project) => Promise<Finding[]>} run returns the todo items
 */

/**
 * Stages that are known only after an install, such as one stage for each addon to update.
 * Each stage that `expand` returns gets its own commit.
 *
 * @typedef {object} StageGroup
 * @property {string} name the id for `--only` and `--from`
 * @property {string} label
 * @property {boolean} [needsInstall] `expand` reads node_modules
 * @property {(project: import('#project.js').Project) => Promise<Stage[]>} expand
 */

export {};
