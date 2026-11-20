import emberGlobals from "./ember-globals/index.js";
import emberNvp from "./ember-nvp/index.js";
import templateTag from "./template-tag/index.js";
import vite from "./vite/index.js";

/**
 * The stages, in the order they run.
 *
 * Each stage expects the project to be in the state that the stages before it leave.
 *
 * @type {import('#types.js').Stage[]}
 */
export const stages = [emberGlobals, vite, templateTag, emberNvp];
