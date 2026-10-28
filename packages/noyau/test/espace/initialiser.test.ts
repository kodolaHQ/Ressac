import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { initialiserEspace, MODELES_PAR_DEFAUT } from "../../src/espace/initialiser.js";
import { createHash } from "node:crypto";
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

test("deux initialisations simultanées ne créent chaque fichier qu'une fois", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const [a, b] = await Promise.all([initialiserEspace(c), initialiserEspace(c)]);
  const tous = [...a.crees, ...b.crees];
  expect(new Set(tous).size).toBe(tous.length);
  expect(tous.length).toBe(attendus.length);
});

test("un AGENTS.md resté au modèle d'origine est mis à jour, un AGENTS.md modifié par l'utilisateur est gardé", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  // Version d'origine connue (HEAD avant le plan 4) : empreinte listée dans ANCIENS_AGENTS.
  const ancien = await readFile(join(import.meta.dirname, "agents-ancien.md"), "utf8");
  expect(createHash("sha256").update(ancien).digest("hex")).toBe(
    "4cb44a141c2e0865ae472910b3f1026b918c2d09d12b96732b7a5556ffcc4681",
  );
  await writeFile(join(c.racine, "AGENTS.md"), ancien);
  await initialiserEspace(c);
  expect(await readFile(join(c.racine, "AGENTS.md"), "utf8")).toBe(modele);

  await writeFile(join(c.racine, "AGENTS.md"), `${ancien}\nmes règles`);
  await initialiserEspace(c);
  expect(await readFile(join(c.racine, "AGENTS.md"), "utf8")).toBe(`${ancien}\nmes règles`);
});

test("initialiser : un AGENTS.md identique à l'ancien modèle est remplacé par le nouveau", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  // Modèle du plan 4 (avant les outils de développement) : empreinte listée dans ANCIENS_AGENTS.
  const ancien = await readFile(join(import.meta.dirname, "agents-plan4.md"), "utf8");
  expect(createHash("sha256").update(ancien).digest("hex")).toBe(
    "3117019dee9b14b0cc47dd8aa33edcfbf8f476a9ea521479c15e7a0c1004eca1",
  );
  await writeFile(join(c.racine, "AGENTS.md"), ancien);
  await initialiserEspace(c);
  const apres = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  expect(apres).toBe(modele);
  expect(apres).toContain("Outils de développement");
});

test("initialiser : un AGENTS.md identique au modèle du plan 5 est remplacé par le nouveau", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  // Premier modèle des outils de développement (f9462f5) : empreinte listée dans ANCIENS_AGENTS.
  const ancien = await readFile(join(import.meta.dirname, "agents-plan5.md"), "utf8");
  expect(createHash("sha256").update(ancien).digest("hex")).toBe(
    "00d106e8d934a49848c9e30f569127b2ccbdde91954a98e9fad1c0914b7d822b",
  );
  await writeFile(join(c.racine, "AGENTS.md"), ancien);
  await initialiserEspace(c);
  const apres = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  expect(apres).toBe(modele);
  expect(apres).toContain("sauf, pour déboguer, par `executer_js`");
  expect(apres).toContain("sauf si l'utilisateur les a coupés");
});

test("initialiser : un AGENTS.md identique au modèle d'avant les espaces privés est remplacé par le nouveau", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  // Modèle de la fin du plan 5 (385a3a1) : empreinte listée dans ANCIENS_AGENTS.
  const ancien = await readFile(join(import.meta.dirname, "agents-avant-plan6.md"), "utf8");
  expect(createHash("sha256").update(ancien).digest("hex")).toBe(
    "6e43cefaf3f1ad8f07dacf4165f66a360e1fd0c3cf3a54c9920de42be25b7ba7",
  );
  await writeFile(join(c.racine, "AGENTS.md"), ancien);
  await initialiserEspace(c);
  const apres = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  expect(apres).toBe(modele);
  expect(apres).toContain("« onglet non partagé »");
  expect(apres).not.toContain("« onglet privé »");
});
