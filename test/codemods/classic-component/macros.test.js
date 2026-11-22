import { expect, test } from "vitest";

import { macroGetter, readPath } from "#codemods/classic-component/macros.js";

/**
 * @param {string} name
 * @param {(string | number)[]} args strings are dependent keys, numbers are other values
 */
function body(name, args) {
  return macroGetter(
    {
      name,
      args: args.map((arg) =>
        typeof arg === "string"
          ? { text: JSON.stringify(arg), string: arg }
          : { text: String(arg) },
      ),
    },
    (key) => (key === "buildResult" ? "this.args" : "this"),
  )?.body;
}

test("paths", () => {
  expect([readPath("a"), readPath("a.b.c"), readPath("on-change"), readPath("a.b", "item")])
    .toMatchInlineSnapshot(`
      [
        "this.a",
        "this.a?.b?.c",
        "this["on-change"]",
        "item.a?.b",
      ]
    `);
});

test("each macro as a getter body", () => {
  expect({
    alias: body("alias", ["parsed.pathname"]),
    readOnly: body("readOnly", ["applyFileFilter.isRunning"]),
    equal: body("equal", ["buildResult.outputFormat", "json"]),
    not: body("not", ["isOpen"]),
    and: body("and", ["a", "b"]),
    or: body("or", ["a", "b.c"]),
    gt: body("gt", ["count", 1]),
    notEmpty: body("notEmpty", ["fileFilter"]),
    mapBy: body("mapBy", ["results", "count"]),
    filterBy: body("filterBy", ["results", "isActive", 1]),
    sum: body("sum", ["usageCounts"]),
    uniqBy: body("uniqBy", ["items", "id"]),
    sort: body("sort", ["items", "sortKeys"]),
  }).toMatchInlineSnapshot(`
    {
      "alias": "this.parsed?.pathname",
      "and": "this.a && this.b",
      "equal": "this.args.buildResult?.outputFormat === "json"",
      "filterBy": "(this.results ?? []).filter((item) => item.isActive === 1)",
      "gt": "this.count > 1",
      "mapBy": "(this.results ?? []).map((item) => item.count)",
      "not": "!this.isOpen",
      "notEmpty": "!isEmpty(this.fileFilter)",
      "or": "this.a || this.b?.c",
      "readOnly": "this.applyFileFilter?.isRunning",
      "sort": undefined,
      "sum": "(this.usageCounts ?? []).reduce((total, value) => total + value, 0)",
      "uniqBy": "(this.items ?? []).filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)",
    }
  `);
});
