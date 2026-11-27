import { installedAddonTree } from "#installed.js";
import { addOverride, hasOverride } from "#manager-settings.js";
import { editPackageJson } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const OLD = "ember-test-waiters";
const NEW = "@ember/test-waiters";
const FALLBACK = "4.1.2";
const SOURCES = ["{app,tests}/**/*.{js,ts,gjs,gts}"];

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
    let dependents = installedAddonTree(project)
      .filter(({ manifest }) => manifest.dependencies?.[OLD])
      .map(({ manifest }) => String(manifest.name));

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
