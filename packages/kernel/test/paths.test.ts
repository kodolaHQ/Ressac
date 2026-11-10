import { afterEach, expect, test } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathInContainer, spacePaths } from "../src/paths.js";

const old = process.env.WEBAIOS_ROOT;
afterEach(() => {
  if (old === undefined) delete process.env.WEBAIOS_ROOT;
  else process.env.WEBAIOS_ROOT = old;
});

test("default paths under ~/WebAiOs", () => {
  delete process.env.WEBAIOS_ROOT;
  const c = spacePaths();
  expect(c.root).toBe(join(homedir(), "WebAiOs"));
  expect(c.widgets).toBe(join(homedir(), "WebAiOs", "home", "widgets"));
  expect(c.mcpConfig).toBe(join(homedir(), "WebAiOs", ".webaios", "mcp.json"));
});

test("WEBAIOS_ROOT overrides the root", () => {
  process.env.WEBAIOS_ROOT = "/tmp/ailleurs";
  const c = spacePaths();
  expect(c.root).toBe("/tmp/ailleurs");
  expect(c.profiles).toBe("/tmp/ailleurs/.webaios/profiles");
});

test("pathInContainer translates a space path and refuses the rest", () => {
  const c = spacePaths("/tmp/w");
  expect(pathInContainer("/tmp/w/home/blocks/x", c)).toBe("/workspace/home/blocks/x");
  expect(pathInContainer("/tmp/w", c)).toBe("/workspace");
  expect(() => pathInContainer("/etc/passwd", c)).toThrow();
  expect(() => pathInContainer("/tmp/w-autre/x", c)).toThrow();
});

test("spacePaths().extensions vaut <racine>/extensions", () => {
  expect(spacePaths("/tmp/w").extensions).toBe("/tmp/w/extensions");
});

test("actions and components under the root", () => {
  const c = spacePaths("/tmp/w");
  expect(c.actions).toBe("/tmp/w/actions");
  expect(c.components).toBe("/tmp/w/components");
});

test("sites under the root", () => {
  expect(spacePaths("/tmp/w").sites).toBe("/tmp/w/sites");
});
