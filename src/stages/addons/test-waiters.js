import { installedAddonTree } from "#installed.js";
import { addOverride, hasOverride, setYamlNestedMap, workspaceRoot } from "#manager-settings.js";
import { editPackageJson } from "#package-json.js";
import { packageManager, published } from "#process.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const OLD = "ember-test-waiters";
const NEW = "@ember/test-waiters";
const FALLBACK = "4.1.2";
const SOURCES = ["{app,tests}/**/*.{js,ts,gjs,gts}"];
const AUTO_IMPORT = "ember-auto-import";
const AUTO_IMPORT_FALLBACK = "2.10.0";
const WORKSPACE = "pnpm-workspace.yaml";

/**
 * @param {Project} project
 * @returns {boolean} the app or an installed addon has the original, and no override replaces it
 */
function hasOriginal(project) {
  if (hasOverride(project, OLD)) return false;

  return (
    Boolean(project.dependency(OLD)) ||
    installedAddonTree(project).some(({ manifest }) => manifest.name === OLD)
  );
}

/**
 * ember-cli loads a v2 addon into a v1 addon only through ember-auto-import 2, and the v1 addons
 * that depended on the old name, such as ember-styleguide 11, have none. The Vite build ignores it.
 *
 * @param {Project} project
 * @param {Record<string, any>[]} manifests the addons that depend on the old name
 */
function addAutoImport(project, manifests) {
  let missing = manifests.filter(
    (manifest) =>
      manifest["ember-addon"]?.version !== 2 &&
      !/^\D*2\./.test(String(manifest.dependencies?.["ember-auto-import"] ?? "")),
  );

  if (missing.length === 0 || packageManager(project) !== "pnpm") return;

  let root = workspaceRoot(project);
  let range = `^${published(AUTO_IMPORT, "2")?.version ?? AUTO_IMPORT_FALLBACK}`;

  for (let manifest of missing) {
    let selector = `${manifest.name}@${manifest.version}`;
    let current = root.has(WORKSPACE) ? root.read(WORKSPACE) : "";

    root.write(
      WORKSPACE,
      setYamlNestedMap(current, "packageExtensions", selector, "dependencies", {
        [AUTO_IMPORT]: range,
      }),
    );
    recordProgress(project, {
      id: `packageExtensions ${selector}`,
      status: "workaround",
      note:
        `pnpm-workspace.yaml adds ${AUTO_IMPORT} to ${selector}, so that ember-cli loads ${NEW} into it. ` +
        "Remove the entry when the app builds with Vite alone.",
      links: ["https://pnpm.io/settings#packageextensions"],
    });
  }
}

/**
 * ember-test-waiters is the old name of @ember/test-waiters, with the same API.
 * Its index re-exports TypeScript types as values, which the Vite build rejects.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: OLD,
  label: `Replace ${OLD} with ${NEW}, its new name`,
  needsInstall: true,

  detect(project) {
    return hasOriginal(project);
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let range = `^${published(NEW)?.version ?? FALLBACK}`;
    let dependentManifests = installedAddonTree(project)
      .map(({ manifest }) => manifest)
      .filter((manifest) => manifest.dependencies?.[OLD]);
    let dependents = dependentManifests.map((manifest) => String(manifest.name));

    if (project.dependency(OLD)) {
      editPackageJson(project, (pkg) => {
        for (let section of ["dependencies", "devDependencies"]) {
          if (!pkg[section]?.[OLD]) continue;

          delete pkg[section][OLD];

          if (!pkg.dependencies?.[NEW] && !pkg.devDependencies?.[NEW]) pkg[section][NEW] = range;
        }
      });

      for (let file of project.files(SOURCES)) {
        let source = project.read(file);
        let output = source.replace(/(['"])ember-test-waiters\1/g, `$1${NEW}$1`);

        if (output !== source) project.write(file, output);
      }
    }

    /**
     * Old addons, such as ember-styleguide 11, still import the original name.
     */
    if (dependents.length > 0) {
      addOverride(project, OLD, `npm:${NEW}@${range}`);
      addAutoImport(project, dependentManifests);
      recordProgress(project, {
        id: `${OLD}: override`,
        status: "override",
        note:
          `An override replaces ${OLD} with ${NEW} for ${dependents.join(", ")}. ` +
          "Remove the override when no dependency depends on the original.",
      });
    }

    return [];
  },
};
