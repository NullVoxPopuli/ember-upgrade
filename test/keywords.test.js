import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Project } from "#project.js";
import { ELEMENT_HELPER, truthHelpers, useKeywords } from "#stages/addons/keywords.js";

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

test("imports become keywords, and not-eq becomes neq", () => {
  expect(
    useKeywords(
      `import notEq from "ember-truth-helpers/helpers/not-eq";
import or from "ember-truth-helpers/helpers/or";
import lt from 'ember-truth-helpers/helpers/lt';
import { on } from "@ember/modifier";

<template>
  {{#if (or @all (lt @index @limit))}}
    <button type="button" {{on "click" @go}}>{{if (notEq @a @b) "changed"}}</button>
  {{/if}}
</template>
`,
      "app/components/x.gjs",
    ),
  ).toMatchInlineSnapshot(`
    "import { on } from "@ember/modifier";

    <template>
      {{#if (or @all (lt @index @limit))}}
        <button type="button" {{on "click" @go}}>{{if (neq @a @b) "changed"}}</button>
      {{/if}}
    </template>
    "
  `);
});

test("named imports keep the helpers that have no keyword", () => {
  expect(
    useKeywords(
      `import { eq, xor, not as isNot } from "ember-truth-helpers";

<template>{{if (eq @a @b) "same"}}{{if (xor @a @b) "one"}}{{if (isNot @c) "no"}}</template>
`,
      "app/components/x.gjs",
    ),
  ).toMatchInlineSnapshot(`
    "import { xor } from "ember-truth-helpers";

    <template>{{if (eq @a @b) "same"}}{{if (xor @a @b) "one"}}{{if (not @c) "no"}}</template>
    "
  `);
});

test("a helper keeps its import when a keyword cannot take its place", () => {
  let source = `import and from "ember-truth-helpers/helpers/and";
import not from "ember-truth-helpers/helpers/not";
import notEq from "ember-truth-helpers/helpers/not-eq";
import eq from "ember-truth-helpers/helpers/eq";

const neq = (a, b) => a !== b;

<template>
  {{if (and @a) "one argument"}}
  {{if (not @a @b) "two arguments"}}
  {{if (notEq @a @b) "neq is a JavaScript name"}}
  <Picker @compare={{eq}} />
</template>
`;

  expect(useKeywords(source, "app/components/x.gjs")).toBeUndefined();
});

test("a block param with the keyword's name keeps the import", () => {
  let source = `import notEq from "ember-truth-helpers/helpers/not-eq";

<template>
  {{#each @pairs as |neq|}}{{if (notEq neq.a neq.b) "x"}}{{/each}}
</template>
`;

  expect(useKeywords(source, "app/components/x.gjs")).toBeUndefined();
});

test("an app that imports the addon without declaring it, as another addon brought it in", async () => {
  let app = project({
    "package.json": { name: "app", devDependencies: { "ember-source": "~7.4.1" } },
    "app/components/x.gjs": `import eq from "ember-truth-helpers/helpers/eq";
<template>{{if (eq @a @b) "same"}}</template>
`,
  });

  expect(truthHelpers.detect(app)).toBe(true);

  await truthHelpers.run(app);

  expect(app.read("app/components/x.gjs")).toMatchInlineSnapshot(`
    "<template>{{if (eq @a @b) "same"}}</template>
    "
  `);
  expect(app.packageJson.devDependencies).toEqual({ "ember-source": "~7.4.1" });
  expect(truthHelpers.detect(app)).toBe(false);
});

test("the element helper becomes the element keyword", () => {
  expect(
    useKeywords(
      `import { element } from "ember-element-helper";
import Tag from "ember-element-helper/helpers/element";

<template>
  {{#let (element @tagName) as |Wrapper|}}<Wrapper>{{yield}}</Wrapper>{{/let}}
  {{#let (Tag "h2" class="x") as |H|}}<H />{{/let}}
</template>
`,
      "app/components/x.gjs",
      ELEMENT_HELPER,
    ),
  ).toMatchInlineSnapshot(`
    "import Tag from "ember-element-helper/helpers/element";

    <template>
      {{#let (element @tagName) as |Wrapper|}}<Wrapper>{{yield}}</Wrapper>{{/let}}
      {{#let (Tag "h2" class="x") as |H|}}<H />{{/let}}
    </template>
    "
  `);
});

test("the helpers that are no keywords move to @ember/utils, or into the app when a module uses them", async () => {
  let app = project({
    "package.json": {
      name: "app",
      devDependencies: { "ember-source": "~7.4.1", "ember-truth-helpers": "^5.0.0" },
    },
    "app/components/x.gjs": `import { eq, xor, isEmpty as empty } from "ember-truth-helpers";

<template>{{if (eq @a @b) "same"}}{{if (xor @a @b) "one"}}{{if (empty @list) "none"}}</template>
`,
    "app/components/nested/y.gjs": `import isArray from "ember-truth-helpers/helpers/is-array";

<template>{{if (isArray @a @b) "lists"}}</template>
`,
  });

  await truthHelpers.run(app);

  expect(app.read("app/components/x.gjs")).toMatchInlineSnapshot(`
    "import xor from '../helpers/xor';
    import { isEmpty as empty } from '@ember/utils';

    <template>{{if (eq @a @b) "same"}}{{if (xor @a @b) "one"}}{{if (empty @list) "none"}}</template>
    "
  `);
  expect(app.read("app/components/nested/y.gjs")).toMatchInlineSnapshot(`
    "import isArray from '../../helpers/is-array';

    <template>{{if (isArray @a @b) "lists"}}</template>
    "
  `);
  expect(app.has("app/helpers/xor.js")).toBe(true);
  expect(app.has("app/helpers/is-array.js")).toBe(true);
  expect(app.has("app/helpers/is-equal.js")).toBe(false);
  expect(app.packageJson.devDependencies).toEqual({ "ember-source": "~7.4.1" });
  expect(truthHelpers.detect(app)).toBe(false);
});
