import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { initSpace, spacePaths, type SpacePaths } from "../../../packages/kernel/src/index.ts";
import { labInUse } from "../host/tiers.ts";

let tmp: string;
let paths: SpacePaths;
const none = async () => false;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "ressac-tiers-"));
  paths = spacePaths(tmp);
  await initSpace(paths);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("empty actions, sites and components: not in use", async () => {
  expect(await labInUse(paths, "browser", none)).toBe(false);
});

test("one action: in use", async () => {
  mkdirSync(join(paths.actions, "rappel"));
  writeFileSync(join(paths.actions, "rappel", "action.json"), "{}");
  expect(await labInUse(paths, "browser", none)).toBe(true);
});

test("only .DS_Store in sites: not in use", async () => {
  writeFileSync(join(paths.sites, ".DS_Store"), "");
  expect(await labInUse(paths, "browser", none)).toBe(false);
});

test("Atelier mode: in use", async () => {
  expect(await labInUse(paths, "workshop", none)).toBe(true);
});

test("a tier-3 widget: in use, asked with its folder", async () => {
  const asked: string[] = [];
  expect(await labInUse(paths, "browser", async (f) => (asked.push(f), f.endsWith("meteo")))).toBe(true);
  expect(asked).toContain(join(paths.widgets, "meteo"));
});

test("a widget link is not followed", async () => {
  const target = mkdtempSync(join(tmpdir(), "ressac-tiers-link-"));
  symlinkSync(target, join(paths.widgets, "lien"));
  const asked: string[] = [];
  expect(await labInUse(paths, "browser", async (f) => (asked.push(f), true)).then(() => asked)).not.toContain(join(paths.widgets, "lien"));
  rmSync(target, { recursive: true, force: true });
});
