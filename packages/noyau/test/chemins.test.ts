import { afterEach, expect, test } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathInContainer, spacePaths } from "../src/chemins.js";

const ancienne = process.env.WEBAIOS_RACINE;
afterEach(() => {
  if (ancienne === undefined) delete process.env.WEBAIOS_RACINE;
  else process.env.WEBAIOS_RACINE = ancienne;
});

test("default paths under ~/WebAiOs", () => {
  delete process.env.WEBAIOS_RACINE;
  const c = spacePaths();
  expect(c.racine).toBe(join(homedir(), "WebAiOs"));
  expect(c.blocs).toBe(join(homedir(), "WebAiOs", "accueil", "blocs"));
  expect(c.widgets).toBe(join(homedir(), "WebAiOs", "accueil", "widgets"));
  expect(c.configMcp).toBe(join(homedir(), "WebAiOs", ".webaios", "mcp.json"));
});

test("WEBAIOS_RACINE overrides the root", () => {
  process.env.WEBAIOS_RACINE = "/tmp/ailleurs";
  const c = spacePaths();
  expect(c.racine).toBe("/tmp/ailleurs");
  expect(c.profils).toBe("/tmp/ailleurs/.webaios/profils");
});

test("cheminDansConteneur translates a space path and refuses the rest", () => {
  const c = spacePaths("/tmp/w");
  expect(pathInContainer("/tmp/w/accueil/blocs/x", c)).toBe("/workspace/accueil/blocs/x");
  expect(pathInContainer("/tmp/w", c)).toBe("/workspace");
  expect(() => pathInContainer("/etc/passwd", c)).toThrow();
  expect(() => pathInContainer("/tmp/w-autre/x", c)).toThrow();
});

test("cheminsEspace().extensions vaut <racine>/extensions", () => {
  expect(spacePaths("/tmp/w").extensions).toBe("/tmp/w/extensions");
});

test("actions and components under the root", () => {
  const c = spacePaths("/tmp/w");
  expect(c.actions).toBe("/tmp/w/actions");
  expect(c.composants).toBe("/tmp/w/composants");
});

test("sites under the root", () => {
  expect(spacePaths("/tmp/w").sites).toBe("/tmp/w/sites");
});
