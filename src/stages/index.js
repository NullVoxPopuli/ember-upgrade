import composableHelpers from "./addons/composable-helpers.js";
import emberCliMirage from "./addons/ember-cli-mirage.js";
import emberFetch from "./addons/ember-fetch.js";
import {
  emberApiActions,
  emberAutoFocus,
  emberCliHead,
  emberErrorRoute,
  emberEventHelpers,
  macroDecorators,
} from "./addons/inline.js";
import emberMetrics from "./addons/ember-metrics.js";
import emberWebApp from "./addons/ember-web-app.js";
import {
  emberCliAutoprefixer,
  emberCliBundleAnalyzer,
  emberCliDependencyLint,
  emberCliDeploy,
  emberDisablePrototypeExtensions,
  emberTestSelectors,
  prember,
  qunitConsoleGrouper,
} from "./addons/removals.js";
import { deprecationWorkflow, emberStyleguide, svgJar, v2Addons } from "./addons/updates.js";
import appTree from "./app-tree/index.js";
import buildSettings from "./build-settings/index.js";
import declareImports from "./declare-imports/index.js";
import emberCli from "./ember-cli/index.js";
import emberCssModules from "./ember-css-modules/index.js";
import emberScopedCss from "./ember-css-modules/vite.js";
import emberGlobals from "./ember-globals/index.js";
import emberNvp from "./ember-nvp/index.js";
import { classicLts, viteLts } from "./ember-source/index.js";
import packageManager from "./package-manager/index.js";
import templateColocation from "./template-colocation/index.js";
import templateTag from "./template-tag/index.js";
import templateWhitespace from "./template-whitespace/index.js";
import undeprecateInject from "./undeprecate-inject/index.js";
import vite from "./vite/index.js";
import viteSass from "./vite-sass/index.js";

/**
 * The stages, in the order they run.
 *
 * Each stage expects the project to be in the state that the stages before it leave.
 * Most addon stages run after the vite stage, because Embroider keeps v1 addons working until each one is updated.
 * The addon stages before the vite stage are for addons that break the Vite build.
 * The package-manager stage is first, because each install after it must give a correct dependency tree.
 * ember-source 7 builds only with Vite, and template-tag-codemod still needs a classic ember-source,
 * so the 7.x steps run just before the ember-nvp stage, which needs 7.2.
 *
 * @type {(import('#types.js').Stage | import('#types.js').StageGroup)[]}
 */
export const stages = [
  packageManager,
  emberGlobals,
  emberWebApp,
  emberStyleguide,
  emberCli,
  emberFetch,
  composableHelpers,
  classicLts,
  /**
   * ember-auto-import does not read package.json `imports`, so `#mirage/...`
   * resolves only after the vite stage. Production builds do not import mirage.
   */
  emberCliMirage,
  emberCssModules,
  vite,
  /** Later stages boot the compat build, where ember-cli-sass can load node-sass. */
  viteSass,
  emberScopedCss,
  emberCliDeploy,
  emberCliAutoprefixer,
  emberTestSelectors,
  prember,
  emberCliBundleAnalyzer,
  emberCliDependencyLint,
  emberDisablePrototypeExtensions,
  qunitConsoleGrouper,
  deprecationWorkflow,
  emberMetrics,
  v2Addons,
  /**
   * Before template-tag, which needs the components that these stages add to resolve,
   * and which would turn the head template of ember-cli-head into a route template.
   */
  emberEventHelpers,
  emberAutoFocus,
  emberErrorRoute,
  emberCliHead,
  emberApiActions,
  macroDecorators,
  templateColocation,
  templateTag,
  svgJar,
  templateWhitespace,
  viteLts,
  buildSettings,
  /**
   * After the addon stages, which change the app's addons, and before ember-nvp,
   * whose apps neither merge app trees nor resolve undeclared packages.
   */
  appTree,
  declareImports,
  emberNvp,
  undeprecateInject,
];
