import { expect, test } from "vitest";

import { useKeywords } from "#stages/addons/truth-helpers.js";

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
