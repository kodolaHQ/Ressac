import { afterEach, expect, test } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { cheminDansConteneur, cheminsEspace } from "../src/chemins.js";

const ancienne = process.env.WEBAIOS_RACINE;
afterEach(() => {
  if (ancienne === undefined) delete process.env.WEBAIOS_RACINE;
  else process.env.WEBAIOS_RACINE = ancienne;
});

test("chemins par défaut sous ~/WebAiOs", () => {
  delete process.env.WEBAIOS_RACINE;
  const c = cheminsEspace();
  expect(c.racine).toBe(join(homedir(), "WebAiOs"));
  expect(c.blocs).toBe(join(homedir(), "WebAiOs", "accueil", "blocs"));
  expect(c.widgets).toBe(join(homedir(), "WebAiOs", "accueil", "widgets"));
  expect(c.configMcp).toBe(join(homedir(), "WebAiOs", ".webaios", "mcp.json"));
});

test("WEBAIOS_RACINE surcharge la racine", () => {
  process.env.WEBAIOS_RACINE = "/tmp/ailleurs";
  const c = cheminsEspace();
  expect(c.racine).toBe("/tmp/ailleurs");
  expect(c.profils).toBe("/tmp/ailleurs/.webaios/profils");
});

test("cheminDansConteneur traduit un chemin de l'espace et refuse le reste", () => {
  const c = cheminsEspace("/tmp/w");
  expect(cheminDansConteneur("/tmp/w/accueil/blocs/x", c)).toBe("/workspace/accueil/blocs/x");
  expect(cheminDansConteneur("/tmp/w", c)).toBe("/workspace");
  expect(() => cheminDansConteneur("/etc/passwd", c)).toThrow();
  expect(() => cheminDansConteneur("/tmp/w-autre/x", c)).toThrow();
});
