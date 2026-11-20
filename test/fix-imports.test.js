import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fixImports } from "#stages/template-tag/fix-imports.js";

test("imports of converted files point to the .gjs file", () => {
  let app = mkdtempSync(join(tmpdir(), "fix-imports-"));

  mkdirSync(join(app, "components"));
  mkdirSync(join(app, "templates"));
  writeFileSync(join(app, "components/jumbo.gjs"), "");
  writeFileSync(join(app, "components/map.js"), "");

  let source = `import Jumbo from "../components/jumbo.js";
import Map from '../components/map.js';
import Gone from "../components/gone.js";
import { LinkTo } from "@ember/routing";
<template><Jumbo /><Map /><Gone /><LinkTo /></template>
`;

  expect(fixImports(source, join(app, "templates/index.gjs"))).toBe(
    source.replace("jumbo.js", "jumbo.gjs"),
  );
});
