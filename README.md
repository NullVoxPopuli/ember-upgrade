# ember-upgrade

```bash
npx ember-upgrade --check
npx ember-upgrade
```

ember-upgrade moves an older Ember app, one stage at a time, to Vite, `<template>` tag, and the [ember.nvp](https://github.com/NullVoxPopuli/ember.nvp) layout.
Each stage makes one git commit. If a stage fails, the commits before it stay, and the next run continues from that stage.

The package has no dependencies. The parsers run as WebAssembly inside the bundle.

## Stages

| Stage                            | What it does                                                                                                                          | Source                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `ember-globals`                  | Replaces `Ember.*` globals with `@ember/*` imports (RFC 176)                                                                          | ember-estree, in this repo              |
| `ember-web-app`                  | Replaces ember-web-app with `public/manifest.webmanifest`                                                                             | this repo                               |
| `ember-styleguide`               | Installs the v2 branch of ember-styleguide from git                                                                                   | this repo                               |
| `vite`                           | Builds with Vite. v1 addons keep working through Embroider                                                                            | `ember-vite-codemod@1.9.0`              |
| `ember-cli-deploy`               | Removes ember-cli-deploy and its plugins                                                                                              | this repo                               |
| `ember-cli-autoprefixer`         | Removes ember-cli-autoprefixer                                                                                                        | this repo                               |
| `ember-test-selectors`           | Removes ember-test-selectors                                                                                                          | this repo                               |
| `prember`                        | Removes prember. vite-ember-ssr replaces it after `ember-nvp`                                                                         | this repo                               |
| `ember-cli-deprecation-workflow` | Updates to v4                                                                                                                         | this repo                               |
| `ember-metrics`                  | Updates to v3, and moves the adapters to the application route                                                                        | ember-estree, in this repo              |
| `v2-addons`                      | Updates each other v1 addon that has a v2 release (`update-<name>`), one commit each. `v1-addons` lists the rest in the progress file | this repo                               |
| `template-tag`                   | Converts `.hbs` templates to `<template>` tag                                                                                         | `@embroider/template-tag-codemod@1.4.2` |
| `svg-jar`                        | Replaces ember-svg-jar with `@svg-jar/plugin`                                                                                         | `@svg-jar/codemod@0.0.1`                |
| `ember-nvp`                      | Moves to the ember.nvp layout, without `@embroider/compat`                                                                            | `ember.nvp@2.4.0`                       |

A stage is done when its `detect` finds nothing more to do.
The stages from other packages run with your package manager (`pnpm dlx`, `yarn dlx`, or `npx`).
Each one is a stage to port to ember-estree, so that the bundle needs nothing from the network.

The addon stages before `vite` are for addons that break the Vite build.

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
