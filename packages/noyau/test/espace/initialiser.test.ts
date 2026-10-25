import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { initialiserEspace } from "../../src/espace/initialiser.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const attendus = [
  "AGENTS.md",
  "CLAUDE.md",
  "accueil/disposition.json",
  "accueil/blocs/daily-dev/bloc.json",
  "accueil/blocs/veille-exemple/bloc.json",
  ".webaios/profils/claude.json",
];

test("crée l'espace complet dans un dossier vide", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const { crees } = await initialiserEspace(c);
  for (const f of attendus) expect(existsSync(join(c.racine, f)), f).toBe(true);
  expect(existsSync(c.projets)).toBe(true);
  expect(crees.length).toBe(attendus.length);
});

test("n'écrase jamais un fichier existant", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.accueil, { recursive: true });
  await writeFile(join(c.racine, "AGENTS.md"), "perso");
  await writeFile(c.disposition, '{"ordre":["mien"]}');
  const { crees } = await initialiserEspace(c);
  expect(await readFile(join(c.racine, "AGENTS.md"), "utf8")).toBe("perso");
  expect(await readFile(c.disposition, "utf8")).toBe('{"ordre":["mien"]}');
  expect(crees).not.toContain(join(c.racine, "AGENTS.md"));
  expect(crees).not.toContain(c.disposition);
});

test("idempotent : un second appel ne crée rien", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  expect((await initialiserEspace(c)).crees).toEqual([]);
});

test("AGENTS.md mentionne les éléments imposés", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  const texte = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  for (const m of ["page_courante", "ouvrir_onglet", "5280", "5299", "0.0.0.0", "etat.json", "/workspace/projets"]) {
    expect(texte, m).toContain(m);
  }
});

test("un bloc de départ supprimé ne revient pas au lancement suivant", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  await rm(join(c.blocs, "veille-exemple"), { recursive: true });
  await writeFile(c.disposition, '{"ordre":["daily-dev"]}');
  await initialiserEspace(c);
  expect(existsSync(join(c.blocs, "veille-exemple"))).toBe(false);
  expect(await readFile(c.disposition, "utf8")).toBe('{"ordre":["daily-dev"]}');
});

test("AGENTS.md, CLAUDE.md et le profil sont recréés s'ils manquent", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  await rm(join(c.racine, "AGENTS.md"));
  await rm(join(c.profils, "claude.json"));
  await initialiserEspace(c);
  expect(existsSync(join(c.racine, "AGENTS.md"))).toBe(true);
  expect(existsSync(join(c.profils, "claude.json"))).toBe(true);
});
