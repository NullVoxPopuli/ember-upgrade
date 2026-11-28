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
 * ember-test-waiters is the old name of @ember/test-waiters, with the same API.
 * Its index re-exports TypeScript types as values, which the Vite build rejects.
 * ember-cli loads the new v2 package into a v1 addon only through ember-auto-import, which old addons such as
 * ember-styleguide 11 do not have, so the vite stage does this, where Embroider loads it.
 *
 * @param {Project} project
 * @returns {boolean} false when neither the app nor an addon has the original
 */
export function replaceTestWaiters(project) {
  if (hasOverride(project, OLD)) return false;

  let dependents = installedAddonTree(project)
    .filter(({ manifest }) => manifest.dependencies?.[OLD])
    .map(({ manifest }) => String(manifest.name));

  if (!project.dependency(OLD) && dependents.length === 0) return false;

  let range = `^${published(NEW)?.version ?? FALLBACK}`;

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

  return true;
}
