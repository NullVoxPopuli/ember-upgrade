import "#quiet-wasi.js";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Project } from "#project.js";
import { run } from "#runner.js";
import { stages } from "#stages/index.js";

const HELP = `Usage: ember-upgrade [directory] [options]

Runs each upgrade stage that the project needs, in order,
with one git commit per stage.

Options:
  --check        Report the next stage and what it leaves for you. Change nothing.
  --only <name>  Run one stage.
  --from <name>  Start at this stage.
  --verify       Install and build after each stage.
  --no-commit    Do not commit after each stage.
  --help         Show this help.

Stages:
${stages.map((s) => `  ${s.name.padEnd(14)} ${s.label}`).join("\n")}
`;

let { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    check: { type: "boolean", default: false },
    only: { type: "string" },
    from: { type: "string" },
    verify: { type: "boolean", default: false },
    commit: { type: "boolean", default: true },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

let selected = stages;
let name = values.only ?? values.from;

if (name) {
  let index = stages.findIndex((stage) => stage.name === name);

  if (index === -1) {
    console.error(`No stage named "${name}". Run ember-upgrade --help to see the stages.`);
    process.exit(1);
  }

  selected = values.only ? [stages[index]] : stages.slice(index);
}

let project = new Project(resolve(positionals[0] ?? "."));

if (!project.has("package.json")) {
  console.error(`No package.json in ${project.directory}`);
  process.exit(1);
}

let result = await run(project, selected, {
  check: values.check,
  commit: values.commit,
  verify: values.verify,
});

process.exit(result.ok ? 0 : 1);
