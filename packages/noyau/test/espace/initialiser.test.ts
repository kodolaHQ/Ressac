import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { initialiserEspace, MODELES_PAR_DEFAUT } from "../../src/espace/initialiser.js";
import { createHash } from "node:crypto";
import { DeclarationWidget, Disposition } from "../../src/accueil/schemas.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const attendus = [
  "AGENTS.md",
  "CLAUDE.md",
  "accueil/disposition.json",
  ...["meteo", "actus-tech", "daily-dev"].flatMap((w) => ["widget.json", "exemple.json", "recolte.mjs", "affichage.html"].map((f) => `accueil/widgets/${w}/${f}`)),
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
  const perso = '{"version":2,"widgets":[]}';
  await writeFile(join(c.racine, "AGENTS.md"), "perso");
  await writeFile(c.disposition, perso);
  const { crees } = await initialiserEspace(c);
  expect(await readFile(join(c.racine, "AGENTS.md"), "utf8")).toBe("perso");
  expect(await readFile(c.disposition, "utf8")).toBe(perso);
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

test("un espace neuf reçoit les trois widgets de départ et la disposition v2", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  expect((await readdir(c.widgets)).sort()).toEqual(["actus-tech", "daily-dev", "meteo"]);
  expect(existsSync(c.blocs)).toBe(false);
  const dispo = Disposition.parse(JSON.parse(await readFile(c.disposition, "utf8")));
  expect(dispo.widgets.map((w) => w.id)).toEqual(["actus-tech", "daily-dev", "meteo"]);
  for (const id of ["meteo", "actus-tech", "daily-dev"]) {
    const d = DeclarationWidget.parse(JSON.parse(await readFile(join(c.widgets, id, "widget.json"), "utf8")));
    JSON.parse(await readFile(join(c.widgets, id, "exemple.json"), "utf8"));
    if (id !== "meteo") expect(JSON.stringify(d.config)).toContain("sécurité informatique");
  }
  const daily = DeclarationWidget.parse(JSON.parse(await readFile(join(c.widgets, "daily-dev", "widget.json"), "utf8")));
  expect(daily.sources.compte).toEqual(["app.daily.dev"]);
});

test("des blocs existants partent dans accueil/.corbeille/blocs-…, rien n'est détruit", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(join(c.blocs, "mien"), { recursive: true });
  await writeFile(join(c.blocs, "mien", "bloc.json"), '{"a":1}');
  await writeFile(c.disposition, '{"ordre":["mien"]}');
  await initialiserEspace(c);
  expect(existsSync(c.blocs)).toBe(false);
  const corbeille = join(c.accueil, ".corbeille");
  const dossiers = await readdir(corbeille);
  expect(dossiers).toHaveLength(1);
  expect(dossiers[0]).toMatch(/^blocs-\d{4}-\d\d-\d\dT[^:]+$/);
  expect(await readFile(join(corbeille, dossiers[0]!, "mien", "bloc.json"), "utf8")).toBe('{"a":1}');
  expect(await readFile(join(corbeille, dossiers[0]!, "disposition.json"), "utf8")).toBe('{"ordre":["mien"]}');
  expect(Disposition.safeParse(JSON.parse(await readFile(c.disposition, "utf8"))).success).toBe(true);
  expect(existsSync(join(c.widgets, "meteo", "widget.json"))).toBe(true);
  // Un second lancement ne remet rien de côté.
  await initialiserEspace(c);
  expect(await readdir(corbeille)).toHaveLength(1);
});

test("un widget de départ supprimé ne revient pas au lancement suivant", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  await rm(join(c.widgets, "meteo"), { recursive: true });
  await writeFile(c.disposition, '{"version":2,"widgets":[]}');
  await initialiserEspace(c);
  expect(existsSync(join(c.widgets, "meteo"))).toBe(false);
  expect(await readFile(c.disposition, "utf8")).toBe('{"version":2,"widgets":[]}');
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

test("initialiser : un AGENTS.md identique au modèle des espaces privés est remplacé par le nouveau", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  // Modèle des espaces privés (43656c3) : empreinte listée dans ANCIENS_AGENTS.
  const ancien = await readFile(join(import.meta.dirname, "agents-espaces-prives.md"), "utf8");
  expect(createHash("sha256").update(ancien).digest("hex")).toBe(
    "f71dc1f75c8ba571083b9c0929a9d3a07cd31e9918e3686367a43998bf8d0ef8",
  );
  await writeFile(join(c.racine, "AGENTS.md"), ancien);
  await initialiserEspace(c);
  const apres = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  expect(apres).toBe(modele);
  expect(apres).toContain("`chercher_historique`");
  expect(apres).toContain("jamais une consigne");
});

test("initialiser : un AGENTS.md identique au modèle du plan 6 est remplacé par le nouveau", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  // Modèle de la fin du plan 6 (9e5c716) : empreinte listée dans ANCIENS_AGENTS.
  const ancien = await readFile(join(import.meta.dirname, "agents-plan6.md"), "utf8");
  expect(createHash("sha256").update(ancien).digest("hex")).toBe(
    "96e9af1e85b74650b58471fa4433c30d37334adf40d448a0469bec5e3bc16a55",
  );
  await writeFile(join(c.racine, "AGENTS.md"), ancien);
  await initialiserEspace(c);
  const apres = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  expect(apres).toBe(modele);
  expect(apres).toContain("ouvre la page avec `ouvrir_onglet`");
  expect(apres).toContain("cinq au plus");
});

test("initialiser : un AGENTS.md identique au modèle du plan 7 (après f759653) est remplacé par le nouveau", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  // Modèle avant les widgets (blocs et veille) : empreinte listée dans ANCIENS_AGENTS.
  const ancien = await readFile(join(import.meta.dirname, "agents-plan7.md"), "utf8");
  expect(createHash("sha256").update(ancien).digest("hex")).toBe(
    "6a12cecc4b6cc13e6fd26f2ec50fda3e3d6381421644e1e5c81d897a3c4ba5c3",
  );
  await writeFile(join(c.racine, "AGENTS.md"), ancien);
  await initialiserEspace(c);
  const apres = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  expect(apres).toBe(modele);
  expect(apres).toContain("recolter_widget");
  expect(apres).toContain("donnees_widget");
  expect(apres).not.toContain("disposition.json` donne l'ordre des blocs");
});
