import { NODE_LTS, NODE_MINIMUM } from "#node-version.js";
import { workspaceRoot } from "#manager-settings.js";
import { readProgress, recordProgress } from "#progress.js";

/** @typedef {import('#project.js').Project} Project */

const WORKFLOWS = [".github/workflows/*.{yml,yaml}"];

/**
 * pnpm commands that are not package.json scripts.
 */
const PNPM_COMMANDS = new Set([
  "add",
  "dlx",
  "exec",
  "i",
  "install",
  "remove",
  "run",
  "update",
  "why",
]);

const INSTALL =
  /^(yarn( install)?( --frozen-lockfile| --non-interactive| --immutable)*|npm (ci|install|i))$/;

/**
 * @param {string} command one command of a `run:` step
 * @param {Record<string, string>} scripts
 * @returns {string}
 */
export function pnpmCommand(command, scripts) {
  let trimmed = command.trim();

  if (INSTALL.test(trimmed)) return command.replace(trimmed, "pnpm install --frozen-lockfile");

  let match = trimmed.match(
    /^(?:yarn(?: run)?|npm(?: run(?:-script)?)?|pnpm(?: run)?) ([\w:.-]+)(.*)$/,
  );

  if (!match) return command;

  let [, name, rest] = match;

  if (/^npm /.test(trimmed) && !/^npm run/.test(trimmed) && name !== "test") return command;
  if (/^yarn /.test(trimmed) && PNPM_COMMANDS.has(name) && name !== "run") return command;

  /**
   * The upgrade renames scripts such as `test:ember` to `test`.
   */
  let script = scripts[name] !== undefined ? name : name.split(":")[0];

  if (scripts[script] === undefined || PNPM_COMMANDS.has(script)) return command;

  return command.replace(trimmed, `pnpm ${script}${rest}`);
}

/**
 * @param {string} source a workflow
 * @param {(command: string) => string} [change]
 * @returns {{ output: string, commands: string[] }} the workflow with each command of its `run:` steps changed
 */
function eachCommand(source, change = (command) => command) {
  /** @type {string[]} */
  let commands = [];
  let changeAll = (/** @type {string} */ text) =>
    text
      .split(/(&&|;|\|\|)/)
      .map((part, i) => {
        if (i % 2 === 1) return part;

        let changed = change(part);

        if (changed.trim()) commands.push(changed.trim());

        return changed;
      })
      .join("");
  /** @type {number | undefined} */
  let block;
  let output = [];

  for (let line of source.split("\n")) {
    let indent = line.match(/^\s*/)?.[0].length ?? 0;

    if (block !== undefined && (line.trim() === "" || indent > block)) {
      output.push(changeAll(line));
      continue;
    }

    block = undefined;

    let run = line.match(/^(\s*(?:- )?run:\s*)(.*)$/);

    if (run && /^[|>]/.test(run[2])) {
      block = indent;
      output.push(line);
    } else if (run) {
      output.push(run[1] + changeAll(run[2]));
    } else {
      output.push(line);
    }
  }

  return { output: output.join("\n"), commands };
}

/**
 * @param {string} source a workflow
 * @returns {boolean}
 */
function runsYarnOrNpm(source) {
  return eachCommand(source).commands.some((command) => /^(yarn|npm)\b/.test(command));
}

/**
 * Moves the jobs of a GitHub Actions workflow to pnpm, and to a Node.js version that Vite runs on.
 *
 * @param {string} source
 * @param {Record<string, string>} scripts the package.json scripts
 * @returns {string}
 */
export function withPnpm(source, scripts) {
  let hasSetup = source.includes("pnpm/action-setup");
  let output = [];

  for (let line of eachCommand(source, (command) => pnpmCommand(command, scripts)).output.split(
    "\n",
  )) {
    let setupNode = line.match(/^(\s*)- uses: actions\/setup-node@/);

    if (setupNode && !hasSetup) output.push(`${setupNode[1]}- uses: pnpm/action-setup@v5`);

    let node = line.match(/^(\s*node-version:\s*)(["']?)(\d+)([.\dx]*)\2\s*$/);

    if (node && Number(node[3]) < NODE_MINIMUM) {
      output.push(`${node[1]}${NODE_LTS}`);
      continue;
    }

    output.push(line.replace(/^(\s*cache:\s*)["']?(yarn|npm)["']?\s*$/, "$1pnpm"));
  }

  return output.join("\n");
}

/**
 * @param {Project} root
 * @returns {Map<string, string>} the changed workflows
 */
function plan(root) {
  /** @type {Map<string, string>} */
  let changes = new Map();

  if (!String(root.packageJson.packageManager ?? "").startsWith("pnpm@")) return changes;

  let scripts = /** @type {Record<string, string>} */ (root.packageJson.scripts ?? {});

  for (let file of root.files(WORKFLOWS)) {
    let source = root.read(file);
    let output = withPnpm(source, scripts);

    if (output !== source) changes.set(file, output);
  }

  return changes;
}

/**
 * The package-manager stage moves the app to pnpm, and the CI workflows still run yarn or npm.
 * They run after the stages that rename the package.json scripts.
 *
 * @type {import('#types.js').Stage}
 */
export default {
  name: "ci-workflows",
  label: "Run pnpm, and a Node.js version that Vite runs on, in the GitHub Actions workflows",

  detect(project) {
    return plan(workspaceRoot(project)).size > 0;
  },

  async check() {
    return { blockers: [], todo: [] };
  },

  async run(project) {
    let root = workspaceRoot(project);

    for (let [file, output] of plan(root)) root.write(file, output);

    let left = root.files(WORKFLOWS).filter((file) => runsYarnOrNpm(root.read(file)));
    let entry = readProgress(project).find((existing) => existing.id === "package-manager");

    /**
     * The package-manager stage listed the workflows that still ran yarn or npm.
     */
    if (entry) {
      let others = (entry.note.match(/These files still run yarn or npm: (.*)\.$/)?.[1] ?? "")
        .split(", ")
        .filter((file) => file && !file.startsWith(".github/workflows/"));
      let files = others.concat(left);
      let note = entry.note.replace(/ These files still run yarn or npm: .*\.$/, "");

      recordProgress(project, {
        ...entry,
        note:
          files.length > 0
            ? `${note} These files still run yarn or npm: ${files.join(", ")}.`
            : note,
      });
    }

    return left.length > 0
      ? [
          {
            title: "These workflows still run yarn or npm",
            where: left,
            action: "Change them to run pnpm.",
          },
        ]
      : [];
  },
};
