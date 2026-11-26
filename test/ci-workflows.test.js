import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { updateNodePins } from "#node-version.js";
import { Project } from "#project.js";
import { readProgress } from "#progress.js";
import ciWorkflows, { pnpmCommand } from "#stages/ci-workflows/index.js";

/**
 * @param {Record<string, string | object>} files
 */
function project(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(
      join(directory, file),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }

  return new Project(directory);
}

/**
 * The workflow is from emberobserver/client.
 */
const WORKFLOW = `name: CI

on:
  push:
    branches:
      - master
  pull_request: {}

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 12
          cache: yarn
      - run: yarn install --frozen-lockfile
      - run: yarn lint

  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 12
          cache: yarn
      - run: yarn install --frozen-lockfile
      - run: yarn test:ember
`;

test("the workflows run pnpm and a Node.js version that Vite runs on", async () => {
  let app = project({
    "package.json": {
      name: "app",
      packageManager: "pnpm@12.23.0",
      scripts: { lint: "eslint .", test: "vite build --mode development && testem ci" },
    },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    ".github/workflows/ci.yml": WORKFLOW,
    "ember-upgrade-progress.yaml": `entries:
  - id: "package-manager"
    status: "todo"
    note: "yarn.lock became pnpm-lock.yaml. These files still run yarn or npm: .github/workflows/ci.yml, README.md."
`,
  });

  expect(ciWorkflows.detect(app)).toBe(true);
  expect(await ciWorkflows.run(app)).toEqual([]);
  expect(app.read(".github/workflows/ci.yml")).toMatchInlineSnapshot(`
    "name: CI

    on:
      push:
        branches:
          - master
      pull_request: {}

    jobs:
      lint:
        name: Lint
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v6
          - uses: pnpm/action-setup@v5
          - uses: actions/setup-node@v6
            with:
              node-version: 24
              cache: pnpm
          - run: pnpm install --frozen-lockfile
          - run: pnpm lint

      test:
        name: Test
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v6
          - uses: pnpm/action-setup@v5
          - uses: actions/setup-node@v6
            with:
              node-version: 24
              cache: pnpm
          - run: pnpm install --frozen-lockfile
          - run: pnpm test
    "
  `);
  expect(readProgress(app).map((entry) => entry.note)).toEqual([
    "yarn.lock became pnpm-lock.yaml. These files still run yarn or npm: README.md.",
  ]);
  expect(ciWorkflows.detect(app)).toBe(false);
});

test("commands without a pnpm equivalent stay, and are left to the app", async () => {
  let app = project({
    "package.json": { name: "app", packageManager: "pnpm@12.23.0", scripts: { test: "testem ci" } },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    ".github/workflows/deploy.yml": `jobs:
  deploy:
    steps:
      - uses: pnpm/action-setup@v5
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - run: |
          npm ci
          yarn deploy:production && npm test
`,
  });

  expect(await ciWorkflows.run(app)).toEqual([
    {
      title: "These workflows still run yarn or npm",
      where: [".github/workflows/deploy.yml"],
      action: "Change them to run pnpm.",
    },
  ]);
  expect(app.read(".github/workflows/deploy.yml")).toMatchInlineSnapshot(`
    "jobs:
      deploy:
        steps:
          - uses: pnpm/action-setup@v5
          - uses: actions/setup-node@v6
            with:
              node-version: 24
          - run: |
              pnpm install --frozen-lockfile
              yarn deploy:production && pnpm test
    "
  `);
});

test("an npm or yarn command becomes the pnpm script that the upgrade kept", () => {
  let scripts = { test: "testem ci", "lint:fix": "eslint --fix ." };

  expect(pnpmCommand("npm run test:ember -- --path dist", scripts)).toBe(
    "pnpm test -- --path dist",
  );
  expect(pnpmCommand(" yarn lint:fix", scripts)).toBe(" pnpm lint:fix");
  expect(pnpmCommand("npm publish", scripts)).toBe("npm publish");
  expect(pnpmCommand("yarn global add ember-cli", scripts)).toBe("yarn global add ember-cli");
});

/**
 * From ember-learn/ember-help-wanted and ember-learn/rfcs-app .npmrc.
 */
test("a Node.js pin older than the build tooling needs moves to the LTS line", () => {
  let app = project({
    "package.json": "{}",
    ".npmrc": "auto-install-peers=true\nuse-node-version=20.20.2\n",
    ".nvmrc": "v22.17.1\n",
    ".node-version": "24.11.0\n",
  });

  expect(updateNodePins(app)).toEqual([".npmrc", ".nvmrc"]);
  expect(app.read(".npmrc")).toBe("auto-install-peers=true\nuse-node-version=24\n");
  expect(app.read(".nvmrc")).toBe("24\n");
  expect(app.read(".node-version")).toBe("24.11.0\n");
});
