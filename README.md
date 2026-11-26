# ember-upgrade

```bash
npx ember-upgrade --check
npx ember-upgrade
```

ember-upgrade moves an older Ember app, one stage at a time, to Vite, `<template>` tag, and the [ember.nvp](https://github.com/NullVoxPopuli/ember.nvp) layout.
Each stage makes one git commit. If a stage fails, the commits before it stay, and the next run continues from that stage.

The package has no dependencies. The parsers run as WebAssembly inside the bundle.

## Stages

| Stage                            | What it does                                                                                                                                                                                          | Source                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `package-manager`                | Moves yarn 1 and npm 6 to pnpm with `pnpm import`, so the versions stay the same. Adds the packages that yarn 1 hoisted and the app imports                                                           | this repo                               |
| `ember-globals`                  | Replaces `Ember.*` globals with `@ember/*` imports (RFC 176)                                                                                                                                          | ember-estree, in this repo              |
| `ember-web-app`                  | Replaces ember-web-app with `public/manifest.webmanifest`                                                                                                                                             | this repo                               |
| `ember-truth-helpers-paths`      | Imports ember-truth-helpers 5 from `helpers/eq` and `helpers/not-eq`, which were `helpers/equal` and `helpers/not-equal`                                                                              | this repo                               |
| `ember-styleguide`               | Installs the v2 branch of ember-styleguide from git                                                                                                                                                   | this repo                               |
| `ember-cli`                      | Updates ember-cli to 4.12, the minimum for the vite stage                                                                                                                                             | this repo                               |
| `ember-fetch`                    | Removes ember-fetch, and uses the global `fetch` (RFC 1065)                                                                                                                                           | ember-estree, in this repo              |
| `ember-composable-helpers`       | Moves to `@nullvoxpopuli/ember-composable-helpers`                                                                                                                                                    | ember-estree, in this repo              |
| `ember-source-classic`           | Updates ember-source one LTS at a time up to 6.12, one commit each (`ember-source-<lts>`), with the packages that each app blueprint lists                                                            | this repo                               |
| `ember-cli-mirage`               | Moves to ember-mirage. `mirage/` stays next to `app/` as `#mirage/...`. Imports what ember-cli-mirage found at runtime, writes models                                                                 | ember-estree, in this repo              |
| `ember-css-modules`              | Moves to ember-scoped-css. Each style module becomes a `<style scoped>` block in its template                                                                                                         | ember-estree, in this repo              |
| `ember-metrics`                  | Updates to v3, and moves the adapters to the application route                                                                                                                                        | ember-estree, in this repo              |
| `v2-addons`                      | Updates each other v1 addon that has a v2 release, and each v2 addon with an old copy of another addon of the app (`update-<name>`), one commit each. `v1-addons` lists the rest in the progress file | this repo                               |
| `peer-copies`                    | Forces the app's copy of each peer dependency that a v1 addon resolves to another copy                                                                                                                | this repo                               |
| `type-imports`                   | Adds `type` to the imports that TypeScript modules use only as types, because the Vite Babel config removes only those                                                                                | this repo                               |
| `vite`                           | Builds with Vite. v1 addons keep working through Embroider. Removes the code that post-processes `app.toTree()`                                                                                       | `ember-vite-codemod@1.9.0`              |
| `ember-scoped-css`               | Adds the ember-scoped-css plugins to the Vite and Babel configs                                                                                                                                       | this repo                               |
| `ember-cli-deploy`               | Removes ember-cli-deploy and its plugins                                                                                                                                                              | this repo                               |
| `ember-cli-autoprefixer`         | Removes ember-cli-autoprefixer                                                                                                                                                                        | this repo                               |
| `ember-test-selectors`           | Removes ember-test-selectors                                                                                                                                                                          | this repo                               |
| `prember`                        | Removes prember. vite-ember-ssr replaces it after `ember-nvp`                                                                                                                                         | this repo                               |
| `ember-cli-deprecation-workflow` | Updates to v4                                                                                                                                                                                         | this repo                               |
| `template-tag`                   | Converts `.hbs` templates to `<template>` tag                                                                                                                                                         | `@embroider/template-tag-codemod@1.4.2` |
| `svg-jar`                        | Replaces ember-svg-jar with `@svg-jar/plugin`                                                                                                                                                         | `@svg-jar/codemod@0.0.1`                |
| `ember-source-vite`              | Updates ember-source to 7.4. ember-source 7 builds only with Vite                                                                                                                                     | this repo                               |
| `ember-nvp`                      | Moves to the ember.nvp layout, without `@embroider/compat`                                                                                                                                            | `ember.nvp@2.5.2`                       |

A stage is done when its `detect` finds nothing more to do.
The stages from other packages run with `npx`.
Each one is a stage to port to ember-estree, so that the bundle needs nothing from the network.

The stages before `vite` remove what ember-vite-codemod refuses, and update the addons whose old dependencies break the Vite build.

### `ember-upgrade-progress.yaml`

ember-upgrade writes this file in the root of the app.
It lists each workaround to undo later, such as a git ref, and the work that a stage leaves for you.
Each entry links the issues and pull requests to follow.

## Options

| Option          | Effect                                                        |
| --------------- | ------------------------------------------------------------- |
| `--check`       | Report the next stage and what it leaves for you. No changes. |
| `--only <name>` | Run one stage.                                                |
| `--from <name>` | Start at this stage.                                          |
| `--verify`      | Install and build after each stage.                           |
| `--no-commit`   | Do not commit after each stage.                               |

## Development

```bash
pnpm install
pnpm test
pnpm lint
pnpm test:bundle
```

`pnpm test:bundle` builds `dist/`, copies it to a folder with no `node_modules`, and runs it there.

### Real apps

```bash
pnpm build
node scripts/trial.js super-rentals --keep
```

CI upgrades each app in [`trials/apps.js`](./trials/apps.js) on every change.
Each app is pinned to a commit, and lists the stages that must complete and the stage where the run must stop.
If a change gets an app further, update its entry in the same PR.

Codemods in this repo use [ember-estree](https://github.com/NullVoxPopuli/ember-estree), not jscodeshift.
They change the source by offset (`src/edits.js`), so code that a stage does not touch keeps its format.
