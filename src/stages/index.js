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
  emberGetConfig,
  emberTestSelectors,
  obsoleteAddons,
  prember,
  qunitConsoleGrouper,
} from "./addons/removals.js";
import {
  deprecationWorkflow,
  emberStyleguide,
  emberStyleguideCss,
  svgJar,
  v2Addons,
  v2AddonsVite,
} from "./addons/updates.js";
import appClass from "./app-class/index.js";
import appTree from "./app-tree/index.js";
import ciWorkflows from "./ci-workflows/index.js";
import classicComponents from "./classic-components/index.js";
import buildSettings from "./build-settings/index.js";
import declareImports from "./declare-imports/index.js";
import defaultQueryParams from "./default-query-params/index.js";
import emberCli from "./ember-cli/index.js";
import emberCliApp from "./ember-cli-app/index.js";
import emberConcurrency from "./ember-concurrency/index.js";
import emberCssModules from "./ember-css-modules/index.js";
import emberScopedCss from "./ember-css-modules/vite.js";
import emberGlobals from "./ember-globals/index.js";
import emberNvp from "./ember-nvp/index.js";
import format from "./format/index.js";
import emberCliServer from "./ember-cli-server/index.js";
import { proxyPluginStage, proxyScriptsStage } from "./ember-serve-proxy/index.js";
import warpDrive from "./warp-drive/index.js";
import warpDriveVersion from "./warp-drive/version.js";
import sass from "./sass/index.js";
import staticSiteJson from "./static-site-json/index.js";
import jqueryIntegration from "./jquery-integration/index.js";
import lint from "./lint/index.js";
import inlineContent from "./addons/inline-content.js";
import powerSelectTypeahead from "./addons/power-select-typeahead.js";
import leaflet from "./addons/leaflet.js";
import netlify from "./addons/netlify.js";
import percyEmber from "./addons/percy.js";
import routerScroll from "./addons/router-scroll.js";
import documentTitle from "./document-title/index.js";
import dynamicComponents from "./dynamic-components/index.js";
import missingComponents from "./missing-components/index.js";
import { classicLts, viteLts } from "./ember-source/index.js";
import packageManager from "./package-manager/index.js";
import patchedPackages from "./patched-packages/index.js";
import truthHelpersPaths from "./addons/truth-helpers.js";
import noImplicitThis from "./no-implicit-this/index.js";
import peerCopies from "./peer-copies/index.js";
import pods from "./pods/index.js";
import templateColocation from "./template-colocation/index.js";
import templateTag from "./template-tag/index.js";
import templateText from "./template-text/index.js";
import templateWhitespace from "./template-whitespace/index.js";
import { elementHelper, truthHelpers } from "./addons/keywords.js";
import typeImports from "./type-imports/index.js";
import undeprecateInject from "./undeprecate-inject/index.js";
import unusedDependencies from "./unused-dependencies/index.js";
import vite from "./vite/index.js";
import viteSass from "./vite-sass/index.js";

/**
 * The stages, in the order they run.
 *
 * Each stage expects the project to be in the state that the stages before it leave.
 * The addon updates run before the vite stage, because the old dependencies of v1 addons break the Vite build.
 * The addon removals run after it, because Vite replaces what most of those addons did.
 * The package-manager stage is first, because each install after it must give a correct dependency tree.
 * ember-source 7 builds only with Vite, and template-tag-codemod still needs a classic ember-source,
 * so the 7.x steps run just before the ember-nvp stage, which needs 7.2.
 *
 * @type {(import('#types.js').Stage | import('#types.js').StageGroup)[]}
 */
export const stages = [
  /**
   * First, so that nothing changes in a project that the stages cannot upgrade.
   */
  emberCliApp,
  packageManager,
  /**
   * After package-manager, whose install gives the versions that the patches are for.
   */
  patchedPackages,
  emberGlobals,
  emberWebApp,
  truthHelpersPaths,
  emberStyleguide,
  emberCli,
  emberFetch,
  composableHelpers,
  /**
   * Before the ember-source steps, whose template codemods parse each template.
   */
  templateText,
  classicLts,
  /**
   * ember-auto-import does not read package.json `imports`, so `#mirage/...`
   * resolves only after the vite stage. Production builds do not import mirage.
   */
  emberCliMirage,
  emberCssModules,
  emberMetrics,
  /** Before v2-addons, which would update ember-power-select-typeahead's dependencies. */
  powerSelectTypeahead,
  routerScroll,
  /**
   * Before v2-addons, which would list these v1 addons as having no v2 release.
   */
  netlify,
  percyEmber,
  emberGetConfig,
  leaflet,
  /**
   * Before vite, because the old dependencies of v1 addons break the Vite build.
   */
  v2Addons,
  peerCopies,
  /**
   * Before vite, whose Babel config removes only the imports that say `type`.
   */
  typeImports,
  /**
   * Before vite, which replaces the `start` script.
   */
  proxyScriptsStage,
  vite,
  emberStyleguideCss,
  /**
   * After vite, which pairs the templates of components outside app/components.
   */
  v2AddonsVite,
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
  obsoleteAddons,
  deprecationWorkflow,
  /**
   * Before template-tag, which needs the components that these stages add to resolve,
   * and which would turn the head template of ember-cli-head into a route template.
   */
  emberEventHelpers,
  emberAutoFocus,
  emberErrorRoute,
  emberCliHead,
  inlineContent,
  emberApiActions,
  macroDecorators,
  pods,
  /**
   * After pods, so that each route's template is at app/templates.
   */
  documentTitle,
  noImplicitThis,
  templateColocation,
  dynamicComponents,
  missingComponents,
  classicComponents,
  templateTag,
  /**
   * After classic-components and template-tag, when the components are native classes in their final files.
   */
  emberConcurrency,
  /**
   * After classic-components, which moves the components' jQuery calls to the DOM.
   */
  jqueryIntegration,
  svgJar,
  templateWhitespace,
  viteLts,
  /**
   * After viteLts, which reaches the URLs of ember-source 7.
   */
  defaultQueryParams,
  /**
   * After viteLts, which reaches the ember-source 7.1 keywords,
   * and before app-tree, which would write the addons' helpers into app/.
   */
  truthHelpers,
  elementHelper,
  buildSettings,
  /**
   * Before ember-nvp, which does not build in-repo addons.
   */
  staticSiteJson,
  /**
   * After the addon stages, which change the app's addons, and before ember-nvp,
   * whose apps neither merge app trees nor resolve undeclared packages.
   */
  appTree,
  declareImports,
  appClass,
  emberNvp,
  /**
   * After ember-nvp, which writes the Vite config.
   */
  emberCliServer,
  proxyPluginStage,
  /**
   * Before warp-drive, which adds WarpDrive packages at the version that the app has.
   */
  warpDriveVersion,
  /**
   * After ember-nvp, which writes app/app.js and the babel config.
   */
  warpDrive,
  /**
   * After ember-nvp, which writes the Vite config.
   */
  sass,
  undeprecateInject,
  /**
   * After the stages that replace tools and addons, so that it finds the packages that only they used.
   */
  unusedDependencies,
  /**
   * After the stages that rename the package.json scripts, which the workflows run.
   */
  ciWorkflows,
  /**
   * After the stages that change code, and before lint, whose suppressions name lines of the formatted code.
   */
  format,
  /**
   * Last, so that the lint errors that it records are the ones in the final code.
   */
  lint,
];
