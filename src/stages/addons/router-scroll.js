import { editPackageJson, removeDependency, setDependency } from "#package-json.js";
import { published } from "#process.js";
import { recordProgress } from "#progress.js";

const OLD = "ember-router-scroll";
const NEW = "@nullvoxpopuli/ember-router-scroll";
const SPECIFIER = /(["'])ember-router-scroll(\/[^"']*)?\1/g;

/**
 * ember-router-scroll is a v1 addon with no v2 release, and it depends on ember-app-scheduler, another one.
 * @nullvoxpopuli/ember-router-scroll is its v2 fork, without ember-app-scheduler.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: OLD,
  label: `Replace ${OLD} with ${NEW}, its v2 fork`,

  detect(project) {
    return Boolean(project.dependency(OLD));
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    for (let file of project.files()) {
      let source = project.read(file);
      let output = source.replace(
        SPECIFIER,
        (_, quote, rest) => `${quote}${NEW}${rest ?? ""}${quote}`,
      );

      if (output !== source) project.write(file, output);
    }

    editPackageJson(project, (pkg) => {
      removeDependency(pkg, OLD);
      setDependency(pkg, NEW, `^${published(NEW)?.version ?? "0.1.3"}`);
    });

    recordProgress(project, {
      id: OLD,
      status: "replaced",
      note: `${OLD} is replaced by ${NEW}, a v2 fork of it that does not depend on ember-app-scheduler.`,
      links: ["https://github.com/NullVoxPopuli/ember-router-scroll"],
    });

    return [];
  },
};
