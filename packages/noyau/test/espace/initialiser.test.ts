import { expect, test, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cheminsEspace } from "../../src/chemins.js";
import { initialiserEspace, MODELES_PAR_DEFAUT, RECOLTES_LIVREES } from "../../src/espace/initialiser.js";
import { createHash } from "node:crypto";
import { DeclarationWidget, Disposition } from "../../src/accueil/schemas.js";
import { dossierTemporaire } from "../aide/temporaire.js";

/** Les fichiers des widgets de départ dans un espace neuf : des workflows, sans recolte.mjs. */
const FICHIERS_DEPART: Record<string, string[]> = {
  meteo: ["widget.json", "exemple.json", "affichage.html", "workflow.json", "ville.mjs", "prevision.mjs"],
  "actus-tech": ["widget.json", "exemple.json", "affichage.html", "workflow.json", "articles.mjs"],
  "daily-dev": ["widget.json", "exemple.json", "affichage.html", "workflow.json", "liens.mjs", "articles.mjs"],
};
/** Le code de la bascule : workflow.json et les .mjs du modèle. */
const CODE_DEPART = (id: string) => FICHIERS_DEPART[id]!.filter((f) => f === "workflow.json" || f.endsWith(".mjs"));

const attendus = [
  "AGENTS.md",
  "CLAUDE.md",
  "accueil/disposition.json",
  ...Object.entries(FICHIERS_DEPART).flatMap(([w, fichiers]) => fichiers.map((f) => `accueil/widgets/${w}/${f}`)),
  ".webaios/profils/claude.json",
];

test("crée l'espace complet dans un dossier vide", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const { crees } = await initialiserEspace(c);
  for (const f of attendus) expect(existsSync(join(c.racine, f)), f).toBe(true);
  expect(existsSync(c.projets)).toBe(true);
  expect(existsSync(c.extensions)).toBe(true);
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

test("initialiser : un AGENTS.md identique au modèle d'avant les workflows est remplacé par le nouveau", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  // Modèle des widgets sans workflows : empreinte listée dans ANCIENS_AGENTS.
  const ancien = await readFile(join(import.meta.dirname, "agents-plan8.md"), "utf8");
  expect(createHash("sha256").update(ancien).digest("hex")).toBe(
    "cf62b40d452d20d454d8d2b836a06c5acf9401b1017314c5f893a913ed37e1fd",
  );
  await writeFile(join(c.racine, "AGENTS.md"), ancien);
  await initialiserEspace(c);
  const apres = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  expect(apres).toBe(modele);
  expect(apres).toContain("workflow.json");
  expect(apres).toContain("executions_widget");
});

test("initialiser : un AGENTS.md identique au modèle du plan 8 est remplacé par le nouveau", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  // Modèle de la fin du plan 8 (e09ed17) : empreinte listée dans ANCIENS_AGENTS.
  const ancien = await readFile(join(import.meta.dirname, "agents-livres", "AGENTS-e09ed17.md"), "utf8");
  expect(createHash("sha256").update(ancien).digest("hex")).toBe(
    "3866a3fd951eb95c9fee1aeae273a9a7eb5ad1b0e09ad8ee85a2f0b3190a634c",
  );
  await writeFile(join(c.racine, "AGENTS.md"), ancien);
  await initialiserEspace(c);
  const apres = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  expect(apres).toBe(modele);
  expect(apres).toContain("workflow_ouvert");
  expect(apres).toContain("constructeur");
  expect(apres).not.toContain("Voir le workflow");
  expect(apres).not.toContain("**Entrée d'un bloc** : `null` sans prédécesseur ;");
});

test("initialiser : un AGENTS.md identique au modèle du plan 9 est remplacé par le nouveau", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  // Modèle de la fin du plan 9 (f01722f) : empreinte listée dans ANCIENS_AGENTS.
  const ancien = await readFile(join(import.meta.dirname, "agents-livres", "AGENTS-f01722f.md"), "utf8");
  expect(createHash("sha256").update(ancien).digest("hex")).toBe(
    "0ccf0a48a1f4b2d39d954382532e0db7e1a84c77640a7eaed7c08dbbfdb88c90",
  );
  await writeFile(join(c.racine, "AGENTS.md"), ancien);
  await initialiserEspace(c);
  const apres = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  expect(apres).toBe(modele);
  for (const attendu of ["web.chercher", "auFilDeLEau", "dureeMaxMinutes", "garderJours", '"heures"', "chercherWeb"]) {
    expect(apres).toContain(attendu);
  }
});

test("initialiser : un AGENTS.md identique au modèle du plan 13 est remplacé par le nouveau", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  // Modèle de la fin du plan 13 (bda1ce9) : empreinte listée dans ANCIENS_AGENTS.
  const ancien = await readFile(join(import.meta.dirname, "agents-livres", "AGENTS-bda1ce9.md"), "utf8");
  expect(createHash("sha256").update(ancien).digest("hex")).toBe(
    "1efeabab021d5ba8f9298cd91ee5c8b76d0fe6f677f2426ddb195421d140629b",
  );
  await writeFile(join(c.racine, "AGENTS.md"), ancien);
  await initialiserEspace(c);
  const apres = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  expect(apres).toBe(modele);
  for (const attendu of [
    "/workspace/extensions/",
    "webaios.json",
    "demander_extension",
    "console_extension",
    "debloquer_console",
    "refermer_console",
    "activeTab",
    "leboncoin.fr",
  ]) {
    expect(apres).toContain(attendu);
  }
});

// ——— Chaque version livrée du modèle AGENTS.md ———

const AGENTS_LIVRES = join(import.meta.dirname, "agents-livres");
const sha256 = (contenu: string | Buffer) => createHash("sha256").update(contenu).digest("hex");

for (const fichier of readdirSync(AGENTS_LIVRES).sort()) {
  test(`un AGENTS.md resté à une version livrée est remplacé par le modèle courant (${fichier})`, async () => {
    const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
    const ancien = await readFile(join(AGENTS_LIVRES, fichier), "utf8");
    // La version courante n'a rien à remplacer.
    if (ancien === modele) return;
    const c = cheminsEspace(await dossierTemporaire());
    await writeFile(join(c.racine, "AGENTS.md"), ancien);
    const { crees } = await initialiserEspace(c);
    expect(await readFile(join(c.racine, "AGENTS.md"), "utf8")).toBe(modele);
    expect(crees).toContain(join(c.racine, "AGENTS.md"));
  });
}

test("chaque version commitée du modèle AGENTS.md est dans agents-livres", async (ctx) => {
  const git = (args: string[]) => execFileSync("git", args, { cwd: MODELES_PAR_DEFAUT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let commits: string[];
  try {
    commits = git(["log", "--format=%h", "--", "AGENTS.md"]).split("\n").filter(Boolean);
  } catch {
    ctx.skip(); // Pas de git (archive, CI sans historique) : les fixtures suffisent.
    return;
  }
  const modele = sha256(await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md")));
  const livres = new Set(await Promise.all(readdirSync(AGENTS_LIVRES).map(async (f) => sha256(await readFile(join(AGENTS_LIVRES, f))))));
  expect(commits.length).toBeGreaterThan(0);
  for (const h of commits) {
    const version = sha256(git(["show", `${h}:./AGENTS.md`]));
    if (version === modele) continue;
    expect(livres.has(version), `version ${h} absente de agents-livres (et sans doute de ANCIENS_AGENTS)`).toBe(true);
  }
});

// ——— Bascule des widgets de départ en workflows ———

const LIVREES = join(import.meta.dirname, "recoltes-livrees");

/** Un espace dont le widget `id` est resté à une ancienne version livrée (recolte.mjs, sans workflow). */
async function espaceAvecAncienneRecolte(id: string, recolte: string) {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  for (const f of CODE_DEPART(id)) await rm(join(c.widgets, id, f));
  await writeFile(join(c.widgets, id, "recolte.mjs"), recolte);
  return c;
}

test("les 7 versions livrées de recolte.mjs ont les empreintes connues", async () => {
  const fichiers = (await readdir(LIVREES)).sort();
  expect(fichiers).toHaveLength(7);
  const empreintes: Record<string, string[]> = {};
  for (const f of fichiers) {
    const id = f.replace(/-[0-9a-f]{7}\.mjs$/, "");
    (empreintes[id] ??= []).push(createHash("sha256").update(await readFile(join(LIVREES, f))).digest("hex"));
  }
  for (const [id, liste] of Object.entries(empreintes)) {
    expect([...RECOLTES_LIVREES[id as keyof typeof RECOLTES_LIVREES]].sort(), id).toEqual(liste.sort());
  }
  expect(Object.keys(empreintes).sort()).toEqual(["actus-tech", "daily-dev", "meteo"]);
});

for (const fichier of readdirSync(join(import.meta.dirname, "recoltes-livrees")).sort()) {
  const id = fichier.replace(/-[0-9a-f]{7}\.mjs$/, "");
  test(`un widget de départ non modifié passe en workflow, son recolte.mjs part à la corbeille (${fichier})`, async () => {
    const ancienne = await readFile(join(LIVREES, fichier), "utf8");
    const c = await espaceAvecAncienneRecolte(id, ancienne);
    // Ce que l'utilisateur voit et règle n'est jamais touché.
    await writeFile(join(c.widgets, id, "widget.json"), '{"nom":"le mien"}');
    await writeFile(join(c.widgets, id, "affichage.html"), "<p>le mien</p>");
    const { crees } = await initialiserEspace(c);

    expect(existsSync(join(c.widgets, id, "recolte.mjs"))).toBe(false);
    for (const f of CODE_DEPART(id)) {
      expect(await readFile(join(c.widgets, id, f), "utf8"), f).toBe(await readFile(join(MODELES_PAR_DEFAUT, "widgets", id, f), "utf8"));
      expect(crees).toContain(join(c.widgets, id, f));
    }
    expect(await readFile(join(c.widgets, id, "widget.json"), "utf8")).toBe('{"nom":"le mien"}');
    expect(await readFile(join(c.widgets, id, "affichage.html"), "utf8")).toBe("<p>le mien</p>");
    const corbeille = await readdir(join(c.accueil, ".corbeille"));
    expect(corbeille).toHaveLength(1);
    expect(corbeille[0]).toMatch(new RegExp(`^${id}-recolte-\\d{4}-\\d\\d-\\d\\dT[^:]+\\.mjs$`));
    expect(await readFile(join(c.accueil, ".corbeille", corbeille[0]!), "utf8")).toBe(ancienne);
    // Les autres widgets de départ n'ont pas bougé, et un second lancement ne fait plus rien.
    expect((await initialiserEspace(c)).crees).toEqual([]);
    expect(await readdir(join(c.accueil, ".corbeille"))).toHaveLength(1);
  });
}

test("un widget de départ modifié n'est pas touché", async () => {
  const ancienne = await readFile(join(LIVREES, "actus-tech-4d4c5f1.mjs"), "utf8");
  const modifiee = ancienne.replace("const GARDER = 15;", "const GARDER = 20;");
  expect(modifiee).not.toBe(ancienne);
  const c = await espaceAvecAncienneRecolte("actus-tech", modifiee);
  await initialiserEspace(c);
  expect(await readFile(join(c.widgets, "actus-tech", "recolte.mjs"), "utf8")).toBe(modifiee);
  for (const f of CODE_DEPART("actus-tech")) expect(existsSync(join(c.widgets, "actus-tech", f)), f).toBe(false);
  expect(existsSync(join(c.accueil, ".corbeille"))).toBe(false);
});

test("un widget de départ qui a déjà son workflow.json, ou un .mjs à lui du même nom, n'est pas touché", async () => {
  const ancienne = await readFile(join(LIVREES, "meteo-4d4c5f1.mjs"), "utf8");
  const c = await espaceAvecAncienneRecolte("meteo", ancienne);
  await writeFile(join(c.widgets, "meteo", "workflow.json"), '{"version":1,"blocs":[],"liens":[]}');
  await initialiserEspace(c);
  expect(await readFile(join(c.widgets, "meteo", "recolte.mjs"), "utf8")).toBe(ancienne);
  expect(await readFile(join(c.widgets, "meteo", "workflow.json"), "utf8")).toBe('{"version":1,"blocs":[],"liens":[]}');
  expect(existsSync(join(c.widgets, "meteo", "prevision.mjs"))).toBe(false);

  const d = await espaceAvecAncienneRecolte("daily-dev", await readFile(join(LIVREES, "daily-dev-4d4c5f1.mjs"), "utf8"));
  await writeFile(join(d.widgets, "daily-dev", "liens.mjs"), "export default () => [];");
  await initialiserEspace(d);
  expect(existsSync(join(d.widgets, "daily-dev", "recolte.mjs"))).toBe(true);
  expect(existsSync(join(d.widgets, "daily-dev", "workflow.json"))).toBe(false);
  expect(existsSync(join(d.widgets, "daily-dev", "articles.mjs"))).toBe(false);
  expect(await readFile(join(d.widgets, "daily-dev", "liens.mjs"), "utf8")).toBe("export default () => [];");
  expect(existsSync(join(d.accueil, ".corbeille"))).toBe(false);
});

test("une bascule interrompue (workflow.json du modèle déjà là, recolte.mjs livré resté) range recolte.mjs", async () => {
  const ancienne = await readFile(join(LIVREES, "daily-dev-4d4c5f1.mjs"), "utf8");
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  // Code et workflow.json du modèle copiés, recolte.mjs pas encore rangé.
  await writeFile(join(c.widgets, "daily-dev", "recolte.mjs"), ancienne);
  const { crees } = await initialiserEspace(c);
  expect(crees).toEqual([]);
  expect(existsSync(join(c.widgets, "daily-dev", "recolte.mjs"))).toBe(false);
  const corbeille = await readdir(join(c.accueil, ".corbeille"));
  expect(corbeille).toHaveLength(1);
  expect(corbeille[0]).toMatch(/^daily-dev-recolte-/);
  expect(await readFile(join(c.accueil, ".corbeille", corbeille[0]!), "utf8")).toBe(ancienne);
  for (const f of CODE_DEPART("daily-dev")) {
    expect(await readFile(join(c.widgets, "daily-dev", f), "utf8"), f).toBe(await readFile(join(MODELES_PAR_DEFAUT, "widgets", "daily-dev", f), "utf8"));
  }
});

test("un widget de l'agent (gmail) n'est pas touché, même avec un recolte.mjs livré", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  const gmail = join(c.widgets, "gmail");
  await mkdir(gmail);
  const fichiers = {
    "widget.json": '{"nom":"Gmail","sources":{"compte":["mail.google.com"],"publiques":[]}}',
    "recolte.mjs": "export default async (webaios) => ({ messages: [] });",
    "affichage.html": "<p>gmail</p>",
  };
  for (const [f, contenu] of Object.entries(fichiers)) await writeFile(join(gmail, f), contenu);
  // Même une copie exacte d'une récolte livrée, hors d'un dossier de départ, reste où elle est.
  const copie = join(c.widgets, "meteo-bis");
  await mkdir(copie);
  await writeFile(join(copie, "recolte.mjs"), await readFile(join(LIVREES, "meteo-4d4c5f1.mjs")));
  await initialiserEspace(c);
  expect((await readdir(gmail)).sort()).toEqual(Object.keys(fichiers).sort());
  for (const [f, contenu] of Object.entries(fichiers)) expect(await readFile(join(gmail, f), "utf8")).toBe(contenu);
  expect(await readdir(copie)).toEqual(["recolte.mjs"]);
  expect(existsSync(join(c.accueil, ".corbeille"))).toBe(false);
});

test("un recolte.mjs livré qui est un lien symbolique n'est pas suivi", async () => {
  const c = await espaceAvecAncienneRecolte("meteo", "");
  await rm(join(c.widgets, "meteo", "recolte.mjs"));
  const dehors = join(await dossierTemporaire(), "recolte.mjs");
  await writeFile(dehors, await readFile(join(LIVREES, "meteo-4d4c5f1.mjs")));
  await symlink(dehors, join(c.widgets, "meteo", "recolte.mjs"));
  await initialiserEspace(c);
  expect(existsSync(join(c.widgets, "meteo", "workflow.json"))).toBe(false);
  expect((await lstat(join(c.widgets, "meteo", "recolte.mjs"))).isSymbolicLink()).toBe(true);
  expect(existsSync(dehors)).toBe(true);
});

test("une bascule ratée ne bloque pas le lancement : les autres widgets passent, le raté réessaie au suivant", async () => {
  const modeles = join(await dossierTemporaire(), "modeles");
  await cp(MODELES_PAR_DEFAUT, modeles, { recursive: true });
  const c = await espaceAvecAncienneRecolte("meteo", await readFile(join(LIVREES, "meteo-4d4c5f1.mjs"), "utf8"));
  for (const f of CODE_DEPART("actus-tech")) await rm(join(c.widgets, "actus-tech", f));
  await writeFile(join(c.widgets, "actus-tech", "recolte.mjs"), await readFile(join(LIVREES, "actus-tech-4d4c5f1.mjs")));
  for (const f of CODE_DEPART("daily-dev")) await rm(join(c.widgets, "daily-dev", f));
  await writeFile(join(c.widgets, "daily-dev", "recolte.mjs"), await readFile(join(LIVREES, "daily-dev-4d4c5f1.mjs")));
  // daily-dev absent des modèles, et une copie de meteo qui échoue (fichier illisible).
  await rm(join(modeles, "widgets", "daily-dev"), { recursive: true });
  await chmod(join(modeles, "widgets", "meteo", "prevision.mjs"), 0o000);
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  let notes = 0;
  try {
    await expect(initialiserEspace(c, modeles)).resolves.toBeDefined();
    notes = erreur.mock.calls.length;
  } finally {
    erreur.mockRestore();
    await chmod(join(modeles, "widgets", "meteo", "prevision.mjs"), 0o644);
  }
  expect(existsSync(join(c.widgets, "actus-tech", "workflow.json"))).toBe(true);
  expect(existsSync(join(c.widgets, "actus-tech", "recolte.mjs"))).toBe(false);
  expect(existsSync(join(c.widgets, "daily-dev", "recolte.mjs"))).toBe(true);
  expect(existsSync(join(c.widgets, "daily-dev", "workflow.json"))).toBe(false);
  expect(existsSync(join(c.widgets, "meteo", "recolte.mjs"))).toBe(true);
  expect(existsSync(join(c.widgets, "meteo", "workflow.json"))).toBe(false);
  expect(notes).toBe(1); // meteo ; daily-dev, absent des modèles, est simplement sauté

  // Au lancement suivant, la copie de meteo réussit (le .mjs déjà copié est identique au modèle).
  await initialiserEspace(c, modeles);
  expect(existsSync(join(c.widgets, "meteo", "workflow.json"))).toBe(true);
  expect(existsSync(join(c.widgets, "meteo", "recolte.mjs"))).toBe(false);
});

test("un espace neuf reçoit les workflows", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  for (const [id, fichiers] of Object.entries(FICHIERS_DEPART)) {
    expect((await readdir(join(c.widgets, id))).sort(), id).toEqual([...fichiers].sort());
  }
  expect(existsSync(join(c.accueil, ".corbeille"))).toBe(false);
});
