import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { withKeywordComponents } from "#stages/template-tag/keyword-components.js";

/**
 * From hashicorp-forge/hermes (MPL-2.0) web/app/components/project/jira-widget, after the codemod, shortened.
 */
test("a template that invokes the app's Action component imports it", () => {
  let root = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  mkdirSync(join(root, "app/components/project"), { recursive: true });
  writeFileSync(
    join(root, "app/components/action.gts"),
    "<template><button>{{yield}}</button></template>\n",
  );

  expect(
    withKeywordComponents(
      `import FlightIcon from '@hashicorp/ember-flight-icons/components/flight-icon';

<template>
  <Action class="add-jira-issue-button">
    <FlightIcon @name="plus" />
  </Action>
  <Dropdown as |dd|><dd.Action /></Dropdown>
  <List as |Input|><Input /></List>
</template>
`,
      "app/components/project/jira-widget.gts",
      root,
    ),
  ).toMatchInlineSnapshot(`
    "import FlightIcon from '@hashicorp/ember-flight-icons/components/flight-icon';
    import Action from '../action';

    <template>
      <Action class="add-jira-issue-button">
        <FlightIcon @name="plus" />
      </Action>
      <Dropdown as |dd|><dd.Action /></Dropdown>
      <List as |Input|><Input /></List>
    </template>
    "
  `);
});
