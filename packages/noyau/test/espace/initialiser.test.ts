import { expect, test, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { initialiserEspace, MODELES_PAR_DEFAUT, RECOLTES_LIVREES, AFFICHAGES_LIVREES, ANCIENS_AGENTS } from "../../src/espace/initialiser.js";
import { createHash } from "node:crypto";
import { DeclarationWidget, Disposition } from "../../src/accueil/schemas.js";
import { DeclarationSite, verifierDeclarationSite } from "../../src/sites/schemas.js";
import { lireReference } from "../../src/pages/plan.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const sha256 = (contenu: string | Buffer) => createHash("sha256").update(contenu).digest("hex");

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

test("creates the full space in an empty folder", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const { crees } = await initialiserEspace(c);
  for (const f of attendus) expect(existsSync(join(c.racine, f)), f).toBe(true);
  expect(existsSync(c.projets)).toBe(true);
  expect(existsSync(c.extensions)).toBe(true);
  expect(existsSync(c.actions)).toBe(true);
  expect(existsSync(c.sites)).toBe(true);
  expect(existsSync(c.composants)).toBe(true);
  expect(crees.length).toBe(attendus.length);
});

test("never overwrites an existing file", async () => {
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

test("idempotent: a second call creates nothing", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  expect((await initialiserEspace(c)).crees).toEqual([]);
});

test("AGENTS.md mentions the required elements", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  const texte = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  for (const m of ["page_courante", "ouvrir_onglet", "5280", "5299", "0.0.0.0", "etat.json", "/workspace/projets"]) {
    expect(texte, m).toContain(m);
  }
});

test("a new space gets the three starter widgets and the v2 layout", async () => {
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

test("existing blocks move to accueil/.corbeille/blocs-…, nothing is destroyed", async () => {
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

test("a v3 layout (Firefox) is kept at launch", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const perso = '{"version":3,"widgets":[{"id":"meteo","x":0,"y":0,"l":500,"h":180}]}';
  await mkdir(c.accueil, { recursive: true });
  await writeFile(c.disposition, perso);
  await initialiserEspace(c);
  expect(await readFile(c.disposition, "utf8")).toBe(perso);
  expect(existsSync(join(c.accueil, ".corbeille"))).toBe(false);
});

test("a deleted starter widget does not come back at the next launch", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  await rm(join(c.widgets, "meteo"), { recursive: true });
  await writeFile(c.disposition, '{"version":2,"widgets":[]}');
  await initialiserEspace(c);
  expect(existsSync(join(c.widgets, "meteo"))).toBe(false);
  expect(await readFile(c.disposition, "utf8")).toBe('{"version":2,"widgets":[]}');
});

test("AGENTS.md, CLAUDE.md and the profile are recreated if missing", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  await rm(join(c.racine, "AGENTS.md"));
  await rm(join(c.profils, "claude.json"));
  await initialiserEspace(c);
  expect(existsSync(join(c.racine, "AGENTS.md"))).toBe(true);
  expect(existsSync(join(c.profils, "claude.json"))).toBe(true);
});

test("two simultaneous initializations create each file only once", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const [a, b] = await Promise.all([initialiserEspace(c), initialiserEspace(c)]);
  const tous = [...a.crees, ...b.crees];
  expect(new Set(tous).size).toBe(tous.length);
  expect(tous.length).toBe(attendus.length);
});

test("a shipped AGENTS.md (its hash is known) is replaced by the current template", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const modele = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  const ancien = "ancien modèle\n";
  const h = sha256(ancien);
  ANCIENS_AGENTS.add(h);
  try {
    await writeFile(join(c.racine, "AGENTS.md"), ancien);
    await initialiserEspace(c);
    expect(await readFile(join(c.racine, "AGENTS.md"), "utf8")).toBe(modele);
  } finally {
    ANCIENS_AGENTS.delete(h);
  }
});

test("an AGENTS.md edited by the user is kept", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const edite = "# Mes règles\nrien d'autre\n";
  await writeFile(join(c.racine, "AGENTS.md"), edite);
  await initialiserEspace(c);
  expect(await readFile(join(c.racine, "AGENTS.md"), "utf8")).toBe(edite);
});

test("the hash of every shipped version is kept: the list only grows", () => {
  expect(ANCIENS_AGENTS.size).toBeGreaterThanOrEqual(36);
  expect(ANCIENS_AGENTS.has("eaf40a1f51b1e62226e5087c7d7a73cf8b48b84e1e4fb214e89a119d0eb71d96")).toBe(true);
});

test("the AGENTS.md template describes the design mode remarks of site apps", async () => {
  const texte = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  for (const motif of ["Remarques du mode design", "/workspace/.webaios/remarques/site-<id>/", "MutationObserver", "site-tiers", "accueil/"]) {
    expect(texte, motif).toContain(motif);
  }
});

test("the site.json examples given in AGENTS.md (YouTube, Vidola) are valid for the site app schema", async () => {
  const texte = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  const blocs = [...texte.matchAll(/```json site\.json:([a-z]+)\n([\s\S]*?)```/g)].map((m) => ({ nom: m[1]!, json: m[2]! }));
  expect(blocs.map((b) => b.nom).sort()).toEqual(["vidola", "youtube"]);
  for (const { nom, json } of blocs) {
    const r = DeclarationSite.safeParse(JSON.parse(json));
    expect(r.success, `${nom} : ${r.success ? "" : r.error.message}`).toBe(true);
    if (!r.success) continue;
    expect(verifierDeclarationSite(r.data, { adressesLocales: false }), nom).toBeNull();
    // Chaque fichier de retouche déclaré est montré dans AGENTS.md.
    for (const r2 of r.data.retouches) for (const f of [...r2.js, ...r2.css]) expect(texte, `${nom} : retouches/${f}`).toContain(`retouches/${f}`);
  }
});

test("the references given as examples in AGENTS.md are valid for the plan reader", async () => {
  const texte = await readFile(join(MODELES_PAR_DEFAUT, "AGENTS.md"), "utf8");
  const blocs = [...texte.matchAll(/```reference\n([\s\S]*?)```/g)].map((m) => m[1]!);
  expect(blocs.length).toBeGreaterThan(0);
  const references = blocs.flatMap((b) => b.split("\n").filter((l) => l.trim() !== ""));
  expect(references.length).toBeGreaterThanOrEqual(3);
  for (const r of references) {
    expect(lireReference(r), r).not.toHaveProperty("erreur");
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

test("the 7 shipped versions of recolte.mjs have the known hashes", async () => {
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
  test(`an unmodified starter widget becomes a workflow, its recolte.mjs goes to the trash (${fichier})`, async () => {
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

test("a modified starter widget is left alone", async () => {
  const ancienne = await readFile(join(LIVREES, "actus-tech-4d4c5f1.mjs"), "utf8");
  const modifiee = ancienne.replace("const GARDER = 15;", "const GARDER = 20;");
  expect(modifiee).not.toBe(ancienne);
  const c = await espaceAvecAncienneRecolte("actus-tech", modifiee);
  await initialiserEspace(c);
  expect(await readFile(join(c.widgets, "actus-tech", "recolte.mjs"), "utf8")).toBe(modifiee);
  for (const f of CODE_DEPART("actus-tech")) expect(existsSync(join(c.widgets, "actus-tech", f)), f).toBe(false);
  expect(existsSync(join(c.accueil, ".corbeille"))).toBe(false);
});

test("a starter widget that already has its workflow.json, or its own .mjs of the same name, is left alone", async () => {
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

test("an interrupted switch (template workflow.json already there, shipped recolte.mjs left) puts recolte.mjs away", async () => {
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

test("an agent widget (gmail) is left alone, even with a shipped recolte.mjs", async () => {
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

test("a shipped recolte.mjs that is a symbolic link is not followed", async () => {
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

test("a failed switch does not block the launch: the other widgets go through, the failed one retries at the next", async () => {
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

test("a new space gets the workflows", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  for (const [id, fichiers] of Object.entries(FICHIERS_DEPART)) {
    expect((await readdir(join(c.widgets, id))).sort(), id).toEqual([...fichiers].sort());
  }
  expect(existsSync(join(c.accueil, ".corbeille"))).toBe(false);
});

// ——— Migration des affichages livrés avant Firefox ———

const AFFICHAGES = join(import.meta.dirname, "affichages-livres");

test("the 9 shipped versions of affichage.html have the known hashes", async () => {
  const fichiers = (await readdir(AFFICHAGES)).sort();
  expect(fichiers).toHaveLength(9);
  const empreintes: Record<string, string[]> = {};
  for (const f of fichiers) {
    const id = f.replace(/-[0-9a-f]{7}\.html$/, "");
    (empreintes[id] ??= []).push(sha256(await readFile(join(AFFICHAGES, f))));
  }
  for (const [id, liste] of Object.entries(empreintes)) {
    expect([...AFFICHAGES_LIVREES[id as keyof typeof AFFICHAGES_LIVREES]].sort(), id).toEqual(liste.sort());
  }
  expect(Object.keys(empreintes).sort()).toEqual(["actus-tech", "daily-dev", "meteo"]);
});

for (const fichier of readdirSync(AFFICHAGES).sort()) {
  const id = fichier.replace(/-[0-9a-f]{7}\.html$/, "");
  test(`a starter display left at a shipped version is replaced by the template (${fichier})`, async () => {
    const ancien = await readFile(join(AFFICHAGES, fichier), "utf8");
    const c = cheminsEspace(await dossierTemporaire());
    await initialiserEspace(c);
    await writeFile(join(c.widgets, id, "affichage.html"), ancien);
    const { crees } = await initialiserEspace(c);
    expect(await readFile(join(c.widgets, id, "affichage.html"), "utf8")).toBe(
      await readFile(join(MODELES_PAR_DEFAUT, "widgets", id, "affichage.html"), "utf8"),
    );
    expect(crees).toContain(join(c.widgets, id, "affichage.html"));
    // Un second lancement ne fait plus rien.
    expect((await initialiserEspace(c)).crees).toEqual([]);
  });
}

test("a starter display modified by the user is left alone", async () => {
  const ancien = await readFile(join(AFFICHAGES, "meteo-4d4c5f1.html"), "utf8");
  const modifie = `${ancien}\n<!-- le mien -->`;
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  await writeFile(join(c.widgets, "meteo", "affichage.html"), modifie);
  const { crees } = await initialiserEspace(c);
  expect(await readFile(join(c.widgets, "meteo", "affichage.html"), "utf8")).toBe(modifie);
  expect(crees).toEqual([]);
});
