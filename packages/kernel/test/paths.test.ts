import { afterEach, expect, test } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathInContainer, spacePaths } from "../src/paths.js";

const old = process.env.RESSAC_ROOT;
afterEach(() => {
  if (old === undefined) delete process.env.RESSAC_ROOT;
  else process.env.RESSAC_ROOT = old;
});

test("default paths under ~/Ressac", () => {
  delete process.env.RESSAC_ROOT;
  const c = spacePaths();
  expect(c.root).toBe(join(homedir(), "Ressac"));
  expect(c.widgets).toBe(join(homedir(), "Ressac", "home", "widgets"));
  expect(c.mcpConfig).toBe(join(homedir(), "Ressac", ".ressac", "mcp.json"));
});

test("RESSAC_ROOT overrides the root", () => {
  process.env.RESSAC_ROOT = "/tmp/ailleurs";
  const c = spacePaths();
  expect(c.root).toBe("/tmp/ailleurs");
  expect(c.profiles).toBe("/tmp/ailleurs/.ressac/profiles");
});

test("pathInContainer translates a space path and refuses the rest", () => {
  const c = spacePaths("/tmp/w");
  expect(pathInContainer("/tmp/w/home/blocks/x", c)).toBe("/workspace/home/blocks/x");
  expect(pathInContainer("/tmp/w", c)).toBe("/workspace");
  expect(() => pathInContainer("/etc/passwd", c)).toThrow();
  expect(() => pathInContainer("/tmp/w-autre/x", c)).toThrow();
});

test("actions and components under the root", () => {
  const c = spacePaths("/tmp/w");
  expect(c.actions).toBe("/tmp/w/actions");
  expect(c.components).toBe("/tmp/w/components");
});

test("sites under the root", () => {
  expect(spacePaths("/tmp/w").sites).toBe("/tmp/w/sites");
});
