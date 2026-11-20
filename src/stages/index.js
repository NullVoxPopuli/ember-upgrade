import emberMetrics from "./addons/ember-metrics.js";
import emberWebApp from "./addons/ember-web-app.js";
import {
  emberCliAutoprefixer,
  emberCliDeploy,
  emberTestSelectors,
  prember,
} from "./addons/removals.js";
import { deprecationWorkflow, emberStyleguide, svgJar, v2Addons } from "./addons/updates.js";
import emberGlobals from "./ember-globals/index.js";
import emberNvp from "./ember-nvp/index.js";
import templateTag from "./template-tag/index.js";
import vite from "./vite/index.js";

/**
 * The stages, in the order they run.
 *
 * Each stage expects the project to be in the state that the stages before it leave.
 * Most addon stages run after the vite stage, because Embroider keeps v1 addons working until each one is updated.
 * The addon stages before the vite stage are for addons that break the Vite build.
 *
 * @type {(import('#types.js').Stage | import('#types.js').StageGroup)[]}
 */
export const stages = [
  emberGlobals,
  emberWebApp,
  emberStyleguide,
  vite,
  emberCliDeploy,
  emberCliAutoprefixer,
  emberTestSelectors,
  prember,
  deprecationWorkflow,
  emberMetrics,
  v2Addons,
  templateTag,
  svgJar,
  emberNvp,
];
