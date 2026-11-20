# ember-upgrade

```bash
npx ember-upgrade --check
npx ember-upgrade
```

ember-upgrade moves an older Ember app, one stage at a time, to Vite, `<template>` tag, and the [ember.nvp](https://github.com/NullVoxPopuli/ember.nvp) layout.
Each stage makes one git commit. If a stage fails, the commits before it stay, and the next run continues from that stage.

The package has no dependencies. The parsers run as WebAssembly inside the bundle.

## Stages

| Stage           | What it does                                                 | Source                                  |
| --------------- | ------------------------------------------------------------ | --------------------------------------- |
| `ember-globals` | Replaces `Ember.*` globals with `@ember/*` imports (RFC 176) | ember-estree, in this repo              |
| `vite`          | Builds with Vite                                             | `ember-vite-codemod@1.9.0`              |
| `template-tag`  | Converts `.hbs` templates to `<template>` tag                | `@embroider/template-tag-codemod@1.4.2` |
| `ember-nvp`     | Moves to the ember.nvp layout, without `@embroider/compat`   | `ember.nvp@2.4.0`                       |

A stage is done when its `detect` finds nothing more to do.
The stages from other packages run with your package manager (`pnpm dlx`, `yarn dlx`, or `npx`).
Each one is a stage to port to ember-estree, so that the bundle needs nothing from the network.

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
