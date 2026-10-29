import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { dossierWidgets, ecrireDisposition, ecrireEtatWidget, ecrireWidget, lancer, nouveauProfil, nouvelleRacine } from "./aide";

// ---------------------------------------------------------------------------------------------------------------------
// Serveurs de test : tout est local. Le site lu par les widgets, un faux Kev et un faux Ollama (sans Gemma).

interface Serveur {
  url: string;
  fermer(): Promise<void>;
}

async function ecouter(gerer: (req: IncomingMessage, res: ServerResponse) => void): Promise<Serveur> {
  const serveur = createServer(gerer);
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`,
    fermer: () =>
      new Promise((ok) => {
        serveur.closeAllConnections();
        serveur.close(() => ok());
      }),
  };
}

let site: Serveur;
/** Journal du faux site : nombre de pages servies. */
let lecturesSite = 0;
let kev: Serveur;
let ollama: Serveur;

test.beforeAll(async () => {
  site = await ecouter((_req, res) => {
    lecturesSite++;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      '<title>Liens</title><a href="https://exemple.invalid/ia">Nouveau modèle IA</a> <a href="https://exemple.invalid/cuisine">Recette de cuisine</a>',
    );
  });
  kev = await ecouter((req, res) => {
    if (req.method === "GET") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"data":[]}');
    let corps = "";
    req.on("data", (d) => (corps += d));
    req.on("end", () => {
      const { state } = JSON.parse(corps) as { state: string };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers: { q: { noul: /\bIA\b/.test(state) ? 0.9 : 0.1 } } }));
    });
  });
  ollama = await ecouter((_req, res) => void res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}'));
});
test.afterAll(async () => {
  await Promise.all([site, kev, ollama].map((s) => s?.fermer()));
});

const lancerWidgets = (racine: string, profil = nouveauProfil()) =>
  lancer({ racine, profil, env: { WEBAIOS_KEV_URL: kev.url, WEBAIOS_OLLAMA_URL: ollama.url, WEBAIOS_TEST_ADRESSES_LOCALES: "1" } });

const AFFICHAGE = `<!doctype html><meta charset="utf-8"><pre id="donnees"></pre>
<script>
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.type !== "widget") return;
    document.getElementById("donnees").textContent = JSON.stringify(e.data.donnees);
  });
</script>`;

const donnees = (fenetre: Page, id: string) => fenetre.frameLocator(`[data-testid="widget-${id}"] iframe`).locator("#donnees");
const lireJson = (chemin: string) => JSON.parse(readFileSync(chemin, "utf8"));
const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Workflow livré par l'agent, sans positions : la page, ses liens extraits par du code, triés par Kev, puis leurs textes. */
const WORKFLOW_VEILLE = {
  version: 1,
  blocs: [
    { id: "page", type: "source.page", parametres: { url: "{config.url}" } },
    { id: "liens", type: "code", nom: "Liens de la page", parametres: { source: "liens.mjs" } },
    { id: "tri", type: "ia.trier", nom: "Tri par Kev", parametres: { question: "Parle d'IA ?", texte: "{texte}", seuil: 0.5 } },
    { id: "textes", type: "code", parametres: { source: "textes.mjs" } },
    { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
  ],
  liens: [
    { de: "page", vers: "liens" },
    { de: "liens", vers: "tri" },
    { de: "tri", vers: "textes" },
    { de: "textes", vers: "sortie" },
  ],
};

function widgetVeille(racine: string): void {
  ecrireWidget(racine, "veille", {
    nom: "Veille",
    recolte: { minutes: 60 },
    config: { url: `${site.url}/liens` },
    workflow: WORKFLOW_VEILLE,
    fichiers: {
      "liens.mjs": "export default async (page) => page.liens;",
      "textes.mjs": "export default async (liens) => ({ liens: liens.map((l) => l.texte) });",
    },
    affichage: AFFICHAGE,
    exemple: { exemple: "veille" },
  });
}

const dossierVeille = (racine: string) => join(racine, "accueil", "widgets", "veille");
/** Ce que le constructeur a pu écrire dans le dossier du widget : noms et dates de modification. */
const instantane = (dossier: string) => readdirSync(dossier).map((f) => `${f}:${statSync(join(dossier, f)).mtimeMs}`).sort();

/** « Voir / modifier le workflow » par le menu du widget : le constructeur s'ouvre dans un onglet. */
async function ouvrirConstructeur(fenetre: Page, id: string): Promise<Locator> {
  const w = fenetre.getByTestId(`widget-${id}`);
  await w.getByRole("button", { name: "Options du widget" }).click();
  await w.getByRole("menuitem", { name: "Voir / modifier le workflow" }).click();
  const page = fenetre.getByTestId("constructeur");
  await expect(page).toBeVisible();
  return page;
}

/** Erreurs de la console de l'interface (violations CSP comprises) et exceptions non rattrapées. */
function erreursConsole(fenetre: Page): string[] {
  const erreurs: string[] = [];
  fenetre.on("console", (m) => {
    if (m.type() === "error") erreurs.push(m.text());
  });
  fenetre.on("pageerror", (e) => erreurs.push(e.message));
  return erreurs;
}

/** Tire un lien de la sortie du bloc `de` vers l'entrée du bloc `vers`. */
async function relier(fenetre: Page, de: string, vers: string): Promise<void> {
  const a = (await fenetre.getByTestId(`noeud-${de}`).locator(".svelte-flow__handle.source").boundingBox())!;
  const b = (await fenetre.getByTestId(`noeud-${vers}`).locator(".svelte-flow__handle.target").boundingBox())!;
  await fenetre.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await fenetre.mouse.down();
  await fenetre.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await fenetre.mouse.up();
}

type Boite = { x: number; y: number; width: number; height: number };
const chevauchent = (a: Boite, b: Boite) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// ---------------------------------------------------------------------------------------------------------------------

test("ouvrir le constructeur d'un workflow livré sans positions le dispose en colonnes et n'écrit rien", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(donnees(fenetre, "veille")).toHaveText('{"exemple":"veille"}');
  const avant = instantane(dossierVeille(racine));
  const erreurs = erreursConsole(fenetre);

  const page = await ouvrirConstructeur(fenetre, "veille");
  await expect(page.getByRole("heading", { name: "Veille" })).toBeVisible();
  const ids = ["page", "liens", "tri", "textes", "sortie"];
  const boites: Boite[] = [];
  for (const id of ids) {
    await expect(fenetre.getByTestId(`noeud-${id}`)).toBeVisible();
    boites.push((await fenetre.getByTestId(`noeud-${id}`).boundingBox())!);
  }
  await expect(fenetre.getByTestId("noeud-liens")).toContainText("Liens de la page");
  await expect(fenetre.getByTestId("noeud-liens")).toContainText("code");
  // Une colonne par rang, de gauche à droite, sans chevauchement.
  for (let i = 1; i < boites.length; i++) expect(boites[i]!.x).toBeGreaterThan(boites[i - 1]!.x + boites[i - 1]!.width / 2);
  for (let i = 0; i < boites.length; i++) for (let j = i + 1; j < boites.length; j++) expect(chevauchent(boites[i]!, boites[j]!)).toBe(false);
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");

  // Sélectionner (clic tremblé de 2 px) et réorganiser n'écrivent rien non plus.
  const b = boites[2]!;
  await fenetre.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await fenetre.mouse.down();
  await fenetre.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2 + 1);
  await fenetre.mouse.up();
  await fenetre.getByTestId("reorganiser").click();
  await attendre(1000);
  expect(instantane(dossierVeille(racine))).toEqual(avant);
  expect(erreurs).toEqual([]);
  await fermer();
});

test("ajouter un bloc par la palette le rend « Non enregistré : … entrée manquante » ; le relier l'enregistre", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const fichier = join(dossierVeille(racine), "workflow.json");
  await ouvrirConstructeur(fenetre, "veille");
  await expect(fenetre.getByTestId("noeud-tri")).toBeVisible();
  // La sortie existe déjà : elle n'est pas proposée.
  await expect(fenetre.getByTestId("palette-sortie")).toHaveCount(0);

  await fenetre.getByTestId("palette-liste.garder").click();
  await expect(fenetre.getByTestId("noeud-liste-garder")).toBeVisible();
  await expect(fenetre.getByTestId("etat-enregistrement")).toContainText("Non enregistré : ");
  await expect(fenetre.getByTestId("etat-enregistrement")).toContainText("entrée manquante");
  await expect(fenetre.getByTestId("noeud-liste-garder")).toHaveClass(/en-erreur/);
  expect(lireJson(fichier)).toEqual(WORKFLOW_VEILLE);

  await relier(fenetre, "tri", "liste-garder");
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  const ecrit = lireJson(fichier);
  expect(ecrit.blocs.find((x: { id: string }) => x.id === "liste-garder")).toMatchObject({ type: "liste.garder", parametres: { nombre: 10 } });
  expect(ecrit.liens).toContainEqual({ de: "tri", vers: "liste-garder" });
  // Le premier geste fige la disposition affichée : chaque bloc a désormais sa position.
  const positions = new Set(ecrit.blocs.map((x: { position: { x: number; y: number } }) => `${x.position.x},${x.position.y}`));
  expect(positions.size).toBe(ecrit.blocs.length);
  await fermer();
});

test("⌘Z annule l'ajout et réenregistre", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const fichier = join(dossierVeille(racine), "workflow.json");
  await ouvrirConstructeur(fenetre, "veille");
  await fenetre.getByTestId("palette-liste.garder").click();
  await relier(fenetre, "tri", "liste-garder");
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  expect(lireJson(fichier).blocs.map((x: { id: string }) => x.id)).toContain("liste-garder");

  // Annuler le lien : le bloc redevient invalide, rien n'est écrit.
  await fenetre.keyboard.press("Meta+z");
  await expect(fenetre.getByTestId("etat-enregistrement")).toContainText("entrée manquante");
  expect(lireJson(fichier).liens).toContainEqual({ de: "tri", vers: "liste-garder" });
  // Annuler l'ajout : le workflow redevient valide et il est réenregistré, sans le bloc.
  await fenetre.keyboard.press("Meta+z");
  await expect(fenetre.getByTestId("noeud-liste-garder")).toHaveCount(0);
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  await expect.poll(() => lireJson(fichier).blocs.map((x: { id: string }) => x.id)).toEqual(["page", "liens", "tri", "textes", "sortie"]);
  // Rétablir le refait.
  await fenetre.keyboard.press("Meta+Shift+z");
  await expect(fenetre.getByTestId("noeud-liste-garder")).toBeVisible();
  await fermer();
});

test("ajouter un bloc Code écrit son fichier .mjs (modèle qui rend son entrée) et enregistre le workflow", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await ouvrirConstructeur(fenetre, "veille");
  await fenetre.getByTestId("palette-code").click();
  await expect(fenetre.getByTestId("noeud-code")).toBeVisible();
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  expect(readFileSync(join(dossierVeille(racine), "code.mjs"), "utf8")).toBe("export default async (entree, webaios) => {\n  return entree;\n};\n");
  const bloc = lireJson(join(dossierVeille(racine), "workflow.json")).blocs.find((x: { id: string }) => x.id === "code");
  expect(bloc).toMatchObject({ type: "code", parametres: { source: "code.mjs" } });
  await fermer();
});

// Repris de la page « Voir le workflow » du plan 8 (accueil.spec.ts), adaptés au constructeur.

test("le constructeur d'un widget en workflow montre ses blocs et, par bloc, les éléments de la dernière exécution ; ▶ Lancer en ajoute une", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  // Sans état : récolté au lancement (planifiée).
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(donnees(fenetre, "veille")).toHaveText('{"liens":["Nouveau modèle IA"]}', { timeout: 20_000 });
  const executions = join(dossierWidgets(profil), "veille", "executions");
  expect(readdirSync(executions)).toHaveLength(1);

  await ouvrirConstructeur(fenetre, "veille");
  await expect(fenetre.locator('[data-testid^="onglet-"]')).toContainText(["Workflow — Veille"]);
  await expect(fenetre.getByTestId("noeud-tri")).toContainText("Tri par Kev");
  await expect(fenetre.getByTestId("noeud-tri")).toContainText("ia.trier");
  // Deux liens en sortie du code, un seul après le tri.
  await expect(fenetre.getByTestId("pastille-liens")).toHaveText("2");
  await expect(fenetre.getByTestId("pastille-tri")).toHaveText("1");
  await expect(fenetre.getByTestId("pastille-tri")).toHaveClass(/ok/);

  const lancerBouton = fenetre.getByTestId("lancer");
  await expect(lancerBouton).toBeEnabled();
  await lancerBouton.click();
  await expect.poll(() => readdirSync(executions).length, { timeout: 20_000 }).toBe(2);
  await expect(lancerBouton).toBeEnabled({ timeout: 20_000 });
  const derniere = readdirSync(executions).sort().at(-1)!;
  expect(lireJson(join(executions, derniere)).declencheur).toBe("manuelle");
  // Lancer n'écrit pas le workflow.
  expect(lireJson(join(dossierVeille(racine), "workflow.json"))).toEqual(WORKFLOW_VEILLE);
  await fermer();
});

test("un widget avec seulement recolte.mjs s'ouvre en workflow implicite (recolte → sortie) sans créer de workflow.json", async () => {
  const racine = nouvelleRacine();
  ecrireWidget(racine, "compte", {
    nom: "Compte",
    recolte: { minutes: 60 },
    sources: { compte: ["127.0.0.1"], publiques: [] },
    config: { url: `${site.url}/lire-cookie?compte` },
    code: `export default async (webaios) => ({ vu: (await webaios.lirePage(webaios.config.url, { compte: true })).titre });`,
    affichage: AFFICHAGE,
    exemple: { exemple: "compte" },
  });
  const profil = nouveauProfil();
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(fenetre.getByTestId("bandeau-accord")).toContainText("127.0.0.1");
  const dossier = join(racine, "accueil", "widgets", "compte");
  const avant = instantane(dossier);
  await ouvrirConstructeur(fenetre, "compte");
  await expect(fenetre.getByTestId("noeud-recolte")).toContainText("code");
  await expect(fenetre.getByTestId("noeud-sortie")).toContainText("sortie");
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  const a = (await fenetre.getByTestId("noeud-recolte").boundingBox())!;
  const b = (await fenetre.getByTestId("noeud-sortie").boundingBox())!;
  expect(chevauchent(a, b)).toBe(false);
  await fenetre.getByTestId("noeud-recolte").click();
  await attendre(800);
  expect(existsSync(join(dossier, "workflow.json"))).toBe(false);
  expect(instantane(dossier)).toEqual(avant);
  await fermer();
});

test("un workflow.json invalide s'ouvre avec son erreur et ne se lance pas ; illisible, il le dit", async () => {
  const racine = nouvelleRacine();
  ecrireWidget(racine, "casse", {
    nom: "Cassé",
    recolte: { minutes: 60 },
    workflow: '{ "version": 1, "blocs": [ { "id": "page", "type": "source.pa',
    affichage: AFFICHAGE,
    exemple: { exemple: "casse" },
  });
  ecrireWidget(racine, "cycle", {
    nom: "Cycle",
    recolte: { minutes: 60 },
    workflow: {
      version: 1,
      blocs: [
        { id: "a", type: "liste.garder", parametres: { nombre: 1 } },
        { id: "b", type: "liste.garder", parametres: { nombre: 1 } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [
        { de: "a", vers: "b" },
        { de: "b", vers: "a" },
        { de: "b", vers: "sortie" },
      ],
    },
    affichage: AFFICHAGE,
    exemple: { exemple: "cycle" },
  });
  ecrireDisposition(racine, [
    { id: "casse", x: 0, y: 0, l: 4, h: 3 },
    { id: "cycle", x: 4, y: 0, l: 4, h: 3 },
  ]);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "casse");
  ecrireEtatWidget(profil, "cycle");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await ouvrirConstructeur(fenetre, "cycle");
  await expect(fenetre.getByTestId("etat-enregistrement")).toContainText("Non enregistré : Workflow invalide : ");
  await expect(fenetre.getByTestId("etat-enregistrement")).toContainText("cycle");
  await expect(fenetre.getByTestId("noeud-a")).toHaveClass(/en-erreur/);
  await expect(fenetre.getByTestId("lancer")).toBeDisabled();

  await fenetre.getByTestId("nouvel-onglet").click();
  await ouvrirConstructeur(fenetre, "casse");
  await expect(fenetre.getByTestId("workflow-illisible")).toContainText("Workflow invalide : ");
  await expect(fenetre.getByTestId("lancer")).toBeDisabled();
  await fermer();
});

// Revue de la tâche 9 (fix round 1)

/** L'agent réécrit `workflow.json` (écriture atomique, comme ses outils). */
function ecrireCommeAgent(racine: string, workflow: unknown): void {
  const fichier = join(dossierVeille(racine), "workflow.json");
  writeFileSync(`${fichier}.agent`, JSON.stringify(workflow, null, 2));
  renameSync(`${fichier}.agent`, fichier);
}
const avecSeuil = (seuil: number) => ({
  ...WORKFLOW_VEILLE,
  blocs: WORKFLOW_VEILLE.blocs.map((b) => (b.id === "tri" ? { ...b, parametres: { ...b.parametres, seuil } } : b)),
});
const seuilDe = (fichier: string) => lireJson(fichier).blocs.find((b: { id: string }) => b.id === "tri").parametres.seuil;

test("Suppr supprime la sélection mais jamais la sortie", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const fichier = join(dossierVeille(racine), "workflow.json");
  await ouvrirConstructeur(fenetre, "veille");
  await fenetre.getByTestId("noeud-sortie").click();
  await fenetre.keyboard.press("Delete");
  await attendre(300);
  await expect(fenetre.getByTestId("noeud-sortie")).toBeVisible();
  expect(lireJson(fichier)).toEqual(WORKFLOW_VEILLE);
  // Avec un autre bloc sélectionné aussi : lui seul part (la sortie, sans entrée, rend le brouillon invalide).
  await fenetre.getByTestId("noeud-textes").click();
  await fenetre.keyboard.down("Meta");
  await fenetre.getByTestId("noeud-sortie").click();
  await fenetre.keyboard.up("Meta");
  await fenetre.keyboard.press("Delete");
  await expect(fenetre.getByTestId("noeud-textes")).toHaveCount(0);
  await expect(fenetre.getByTestId("noeud-sortie")).toBeVisible();
  await expect(fenetre.getByTestId("etat-enregistrement")).toContainText("entrée manquante");
  expect(lireJson(fichier)).toEqual(WORKFLOW_VEILLE);
  await fermer();
});

test("⌘Z tapé dans un champ de texte ne défait pas le canevas", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await ouvrirConstructeur(fenetre, "veille");
  await fenetre.getByTestId("palette-liste.garder").click();
  await expect(fenetre.getByTestId("noeud-liste-garder")).toBeVisible();
  const barre = fenetre.getByTestId("barre-adresse");
  await barre.click();
  await barre.pressSequentially("abc");
  await barre.press("Meta+z");
  await attendre(300);
  await expect(fenetre.getByTestId("noeud-liste-garder")).toBeVisible();
  // Hors du champ, ⌘Z défait l'ajout.
  await fenetre.getByTestId("constructeur").getByRole("heading", { name: "Veille" }).click();
  await fenetre.keyboard.press("Meta+z");
  await expect(fenetre.getByTestId("noeud-liste-garder")).toHaveCount(0);
  await fermer();
});

test("l'agent réécrit workflow.json pendant un brouillon invalide : bandeau, « Garder la mienne » puis « Prendre sa version »", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const fichier = join(dossierVeille(racine), "workflow.json");
  await ouvrirConstructeur(fenetre, "veille");
  await fenetre.getByTestId("palette-liste.garder").click();
  await expect(fenetre.getByTestId("etat-enregistrement")).toContainText("entrée manquante");

  ecrireCommeAgent(racine, avecSeuil(0.7));
  const bandeau = fenetre.getByTestId("bandeau-fichier");
  await expect(bandeau).toBeVisible();
  // Un geste pendant le bandeau n'écrase pas la version de l'agent.
  await relier(fenetre, "tri", "liste-garder");
  await attendre(500);
  await expect(bandeau).toBeVisible();
  expect(seuilDe(fichier)).toBe(0.7);
  // Garder la mienne : mon brouillon (relié, donc valide) remplace la version de l'agent.
  await fenetre.getByTestId("garder-mienne").click();
  await expect(bandeau).toBeHidden();
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  await expect.poll(() => seuilDe(fichier)).toBe(0.5);
  expect(lireJson(fichier).liens).toContainEqual({ de: "tri", vers: "liste-garder" });

  // Nouveau brouillon invalide, nouvelle version de l'agent : la prendre abandonne le brouillon, sans rien écrire.
  await fenetre.getByTestId("palette-liste.garder").click();
  await expect(fenetre.getByTestId("noeud-liste-garder-2")).toBeVisible();
  ecrireCommeAgent(racine, avecSeuil(0.9));
  await expect(bandeau).toBeVisible();
  const avant = statSync(fichier).mtimeMs;
  await fenetre.getByTestId("prendre-version").click();
  await expect(bandeau).toBeHidden();
  await expect(fenetre.getByTestId("noeud-liste-garder-2")).toHaveCount(0);
  await expect(fenetre.getByTestId("noeud-liste-garder")).toHaveCount(0);
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  await attendre(500);
  expect(statSync(fichier).mtimeMs).toBe(avant);
  expect(seuilDe(fichier)).toBe(0.9);
  await fermer();
});

// Tâche 10 : l'onglet « Bloc »

const memoireDe = (profil: string) => join(dossierWidgets(profil), "veille", "memoire.json");

test("changer le seuil d'ia.trier dans l'onglet Bloc réécrit workflow.json et efface la mémoire de ce bloc seulement", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  writeFileSync(
    memoireDe(profil),
    JSON.stringify({ version: 1, blocs: { tri: { type: "ia.trier", valeur: { vus: ["a"] } }, textes: { type: "code", valeur: { vus: ["b"] } } } }),
  );
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const fichier = join(dossierVeille(racine), "workflow.json");
  await ouvrirConstructeur(fenetre, "veille");
  // Aucun bloc sélectionné : le panneau du widget, en lecture seule.
  const panneau = fenetre.getByTestId("panneau-widget");
  await expect(panneau).toContainText("Pour changer les sources ou la configuration, demande-le à l'agent.");
  await expect(fenetre.getByTestId("widget-config")).toContainText(`"url": "${site.url}/liens"`);

  await fenetre.getByTestId("noeud-tri").click();
  const onglet = fenetre.getByTestId("volet-bloc");
  await expect(onglet.getByTestId("nom-bloc")).toHaveValue("Tri par Kev");
  await expect(onglet.getByTestId("id-bloc")).toHaveText("tri");
  await expect(onglet.getByTestId("champ-question")).toHaveValue("Parle d'IA ?");
  // ia.trier note toujours élément par élément : ses champs « par élément » sont là, sans case parElement.
  await expect(onglet.getByTestId("champ-siErreur")).toBeVisible();
  await expect(onglet.getByTestId("champ-parElement")).toHaveCount(0);
  // Sélectionner n'écrit rien.
  await attendre(500);
  expect(lireJson(fichier)).toEqual(WORKFLOW_VEILLE);

  // Une saisie illisible (« - ») n'écrit rien ; quittée, le champ remontre la valeur du bloc.
  const seuil = onglet.getByTestId("champ-seuil");
  await seuil.click();
  await seuil.press("Meta+a");
  await seuil.pressSequentially("-");
  await seuil.press("Tab");
  await expect(seuil).toHaveValue("0.5");
  // Un nombre ne s'enregistre pas en cours de frappe (« 0. » effacerait la mémoire) : Entrée ou perte du focus.
  await seuil.fill("0.7");
  await attendre(700);
  expect(seuilDe(fichier)).toBe(0.5);
  expect(Object.keys(lireJson(memoireDe(profil)).blocs)).toEqual(["tri", "textes"]);
  await seuil.press("Enter");
  await expect.poll(() => seuilDe(fichier)).toBe(0.7);
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  await expect.poll(() => Object.keys(lireJson(memoireDe(profil)).blocs)).toEqual(["textes"]);
  // Revenir à la valeur du focus après un enregistrement s'enregistre aussi.
  await seuil.fill("0.5");
  await seuil.press("Tab");
  await expect.poll(() => seuilDe(fichier)).toBe(0.5);
  await expect(seuil).toHaveValue("0.5");
  // ⌘Z (hors du champ) défait une édition du champ en une seule fois.
  await seuil.fill("0.8");
  await seuil.press("Tab");
  await expect.poll(() => seuilDe(fichier)).toBe(0.8);
  await fenetre.getByTestId("constructeur").getByRole("heading", { name: "Veille" }).click();
  await fenetre.keyboard.press("Meta+z");
  await expect.poll(() => seuilDe(fichier)).toBe(0.5);
  await fermer();
});

test("un gabarit {config.inconnu} affiche un avertissement et s'enregistre quand même", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const fichier = join(dossierVeille(racine), "workflow.json");
  await ouvrirConstructeur(fenetre, "veille");
  await fenetre.getByTestId("noeud-tri").click();
  const question = fenetre.getByTestId("champ-question");
  await question.fill("{config.inconnu} ?");
  // Enregistré après 400 ms sans frappe, sans perdre le focus.
  await expect.poll(() => lireJson(fichier).blocs.find((b: { id: string }) => b.id === "tri").parametres.question).toBe("{config.inconnu} ?");
  await expect(fenetre.getByTestId("avertissement-tri")).toContainText("config.inconnu absent de la configuration du widget");
  await expect(fenetre.getByTestId("noeud-tri")).toHaveClass(/avertit/);
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  // Revenir au texte du focus, dans la même séance, s'enregistre : l'avertissement part.
  const questionDe = () => lireJson(fichier).blocs.find((b: { id: string }) => b.id === "tri").parametres.question;
  await question.fill("Parle d'IA ?");
  await expect.poll(questionDe).toBe("Parle d'IA ?");
  await expect(fenetre.getByTestId("avertissement-tri")).toHaveCount(0);
  // Une frappe en attente quand on change de bloc est enregistrée sur son bloc, pas sur le nouveau.
  await question.fill("Parle de cuisine ?");
  await fenetre.getByTestId("noeud-liens").click();
  await expect.poll(questionDe).toBe("Parle de cuisine ?");
  // (Le premier geste a figé les positions affichées : seule la position s'ajoute.)
  const { position: _p, ...liens } = lireJson(fichier).blocs.find((b: { id: string }) => b.id === "liens");
  expect(liens).toEqual(WORKFLOW_VEILLE.blocs[1]);
  await fermer();
});

/** Remplace `confirm` de l'interface : rien ne s'affiche, les questions sont notées, la réponse est `reponse`. */
async function repondreConfirm(fenetre: Page, reponse: boolean): Promise<void> {
  await fenetre.evaluate((r) => {
    const w = window as unknown as { questions?: string[]; confirm: (m?: string) => boolean };
    w.questions ??= [];
    w.confirm = (m?: string) => {
      w.questions!.push(m ?? "");
      return r;
    };
  }, reponse);
}
const questions = (fenetre: Page) => fenetre.evaluate(() => (window as unknown as { questions?: string[] }).questions ?? []);
const fermetureRetenue = (fenetre: Page) =>
  fenetre.evaluate(() => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });

test("le code d'un bloc code ne s'écrit qu'avec Enregistrer le code ; ⌘S aussi", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { app, fenetre, fermer } = await lancerWidgets(racine, profil);
  const code = join(dossierVeille(racine), "liens.mjs");
  await ouvrirConstructeur(fenetre, "veille");
  await fenetre.getByTestId("noeud-liens").click();
  const editeur = fenetre.getByTestId("editeur-code");
  await expect(editeur).toHaveValue("export default async (page) => page.liens;");
  await expect(fenetre.getByTestId("code-non-enregistre")).toHaveCount(0);

  await editeur.fill("export default async (page) => page.liens.slice(0, 1);");
  await expect(fenetre.getByTestId("code-non-enregistre")).toHaveText("Code non enregistré");
  await attendre(800);
  expect(readFileSync(code, "utf8")).toBe("export default async (page) => page.liens;");
  await fenetre.getByTestId("enregistrer-code").click();
  await expect.poll(() => readFileSync(code, "utf8")).toBe("export default async (page) => page.liens.slice(0, 1);");
  await expect(fenetre.getByTestId("code-non-enregistre")).toHaveCount(0);

  await editeur.fill("export default async (page) => page.liens.slice(0, 2);");
  await editeur.press("Meta+s");
  await expect.poll(() => readFileSync(code, "utf8")).toBe("export default async (page) => page.liens.slice(0, 2);");
  await expect(fenetre.getByTestId("code-non-enregistre")).toHaveCount(0);
  // Le workflow n'a pas été touché.
  expect(lireJson(join(dossierVeille(racine), "workflow.json"))).toEqual(WORKFLOW_VEILLE);

  // Un brouillon : changer de bloc demande ; refusé, le bloc reste ; accepté, le brouillon est gardé pour le retour.
  await editeur.fill("// brouillon");
  expect(await fermetureRetenue(fenetre)).toBe(true);
  await repondreConfirm(fenetre, false);
  await fenetre.getByTestId("noeud-tri").click();
  await attendre(300);
  expect(await questions(fenetre)).toHaveLength(1);
  await expect(fenetre.getByTestId("nom-bloc")).toHaveValue("Liens de la page");
  await repondreConfirm(fenetre, true);
  await fenetre.getByTestId("noeud-tri").click();
  await expect(fenetre.getByTestId("nom-bloc")).toHaveValue("Tri par Kev");
  await fenetre.getByTestId("noeud-liens").click();
  await expect(fenetre.getByTestId("editeur-code")).toHaveValue("// brouillon");
  await expect(fenetre.getByTestId("code-non-enregistre")).toBeVisible();

  // L'agent écrit le fichier pendant le brouillon : bandeau, le brouillon reste affiché.
  writeFileSync(code, "export default async (page) => page.liens; // agent");
  await expect(fenetre.getByTestId("code-change")).toContainText("Le fichier a changé sur le disque");
  await expect(fenetre.getByTestId("editeur-code")).toHaveValue("// brouillon");
  await fenetre.getByTestId("garder-code").click();
  await expect(fenetre.getByTestId("code-change")).toHaveCount(0);

  // Fermer l'onglet (bouton ou ⌘W) demande aussi ; refusé, il reste ; accepté, il se ferme et le brouillon est abandonné.
  const ongletConstructeur = fenetre.locator('[data-testid^="onglet-"]', { hasText: "Workflow — Veille" });
  await repondreConfirm(fenetre, false);
  await ongletConstructeur.getByRole("button", { name: "Fermer l'onglet" }).click();
  await attendre(300);
  await expect(ongletConstructeur).toHaveCount(1);
  expect((await questions(fenetre)).at(-1)).toContain("liens.mjs");
  const n = (await questions(fenetre)).length;
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("fermer-onglet")?.click());
  await expect.poll(async () => (await questions(fenetre)).length).toBe(n + 1);
  await expect(ongletConstructeur).toHaveCount(1);
  await repondreConfirm(fenetre, true);
  await ongletConstructeur.getByRole("button", { name: "Fermer l'onglet" }).click();
  await expect(ongletConstructeur).toHaveCount(0);
  expect(await fermetureRetenue(fenetre)).toBe(false);
  expect(readFileSync(code, "utf8")).toBe("export default async (page) => page.liens; // agent");
  await fermer();
});

test("une sortie qui contient <img src=x onerror=…> s'affiche en texte", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const piege = '<img src=x onerror="window.piege=1">';
  const debut = "2026-10-29T10:00:00.000Z";
  const id = "2026-10-29T10-00-00-000Z";
  const trace = (bloc: string, type: string, champs: Record<string, unknown>) => ({
    id: bloc,
    type,
    statut: "reussi",
    debut,
    fin: "2026-10-29T10:00:01.500Z",
    elements: null,
    journal: [],
    ...champs,
  });
  const dossier = join(dossierWidgets(profil), "veille", "executions");
  mkdirSync(dossier, { recursive: true });
  writeFileSync(
    join(dossier, `${id}.json`),
    JSON.stringify({
      version: 1,
      id,
      proprietaire: { type: "widget", id: "veille" },
      declencheur: "planifiee",
      debut,
      fin: "2026-10-29T10:00:02.000Z",
      statut: "partielle",
      blocs: [
        trace("page", "source.page", { sortie: { titre: piege } }),
        trace("liens", "code", { elements: 1, sortie: [{ texte: piege, url: "https://exemple.invalid/" }], journal: [piege] }),
        trace("tri", "ia.trier", { statut: "echoue", erreur: piege }),
        trace("textes", "code", { statut: "pas-lance", debut: null, fin: null }),
        trace("sortie", "sortie", { statut: "pas-lance", debut: null, fin: null }),
      ],
    }),
  );
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await ouvrirConstructeur(fenetre, "veille");
  const images = await fenetre.locator("img").count();
  await expect(fenetre.getByTestId("pastille-liens")).toHaveText("1");

  await fenetre.getByTestId("noeud-liens").click();
  const sortie = fenetre.getByTestId("sortie-bloc");
  await expect(sortie.getByTestId("statut-bloc")).toHaveText("réussi");
  await expect(sortie).toContainText("1,5 s");
  await sortie.getByText("Journal (1)").click();
  await expect(sortie.getByTestId("journal-bloc")).toHaveText(piege);
  // La sortie n'est mise en forme qu'une fois ouverte.
  await expect(sortie.getByTestId("sortie-json")).toHaveCount(0);
  await sortie.getByTestId("sortie-repliable").locator("summary").click();
  await expect(sortie.getByTestId("sortie-json")).toContainText('"texte": "<img src=x onerror=');

  await fenetre.getByTestId("noeud-tri").click();
  await expect(fenetre.getByTestId("erreur-bloc")).toHaveText(piege);
  // Les champs de la sortie amont (liens) et la configuration sont proposés aux gabarits.
  await expect(fenetre.getByTestId("disponibles-texte")).toHaveText("Champs disponibles : {texte} {url} {config.url}");

  expect(await fenetre.locator("img").count()).toBe(images);
  expect(await fenetre.locator('img[src="x"]').count()).toBe(0);
  expect(await fenetre.evaluate(() => (window as unknown as { piege?: number }).piege)).toBeUndefined();
  await fermer();
});

// ---------------------------------------------------------------------------------------------------------------------
// Exécutions, « ▶ Lancer », « Rejouer depuis ce bloc » et aperçu (tâche 11).

/** Le dernier bloc de code attend un peu : de quoi voir les pastilles « en cours » et les boutons grisés. */
function widgetVeilleLent(racine: string): void {
  widgetVeille(racine);
  writeFileSync(
    join(dossierVeille(racine), "textes.mjs"),
    "export default async (liens) => { await new Promise((r) => setTimeout(r, 2500)); return { liens: liens.map((l) => l.texte) }; };",
  );
}
const dossierExecutionsDe = (profil: string) => join(dossierWidgets(profil), "veille", "executions");
const apercu = (fenetre: Page) => fenetre.frameLocator('[data-testid="apercu-widget"] iframe').locator("#donnees");
/** Le contenu d'un fichier du widget hors de l'espace (données, mémoire, état), ou null s'il n'existe pas. */
const contenu = (chemin: string) => (existsSync(chemin) ? readFileSync(chemin, "utf8") : null);

test("▶ Lancer : pastilles en cours puis éléments par bloc, nouvelle exécution choisie, aperçu à jour", async () => {
  const racine = nouvelleRacine();
  widgetVeilleLent(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const erreurs = erreursConsole(fenetre);
  await ouvrirConstructeur(fenetre, "veille");
  await expect(fenetre.getByTestId("noeud-textes")).toBeVisible();
  // Aucune exécution : l'aperçu montre l'exemple, comme l'accueil.
  await fenetre.getByTestId("bouton-apercu").click();
  await expect(apercu(fenetre)).toHaveText('{"exemple":"veille"}');
  await expect(fenetre.getByTestId("apercu-mention")).toHaveCount(0);

  await fenetre.getByTestId("lancer").click();
  await expect(fenetre.getByTestId("pastille-textes")).toHaveClass(/en-cours/, { timeout: 20_000 });
  await expect(fenetre.getByTestId("pastille-liens")).toHaveText("2");
  await expect(fenetre.getByTestId("lancer")).toBeDisabled();
  await expect(fenetre.getByTestId("pastille-textes")).toHaveClass(/ok/, { timeout: 20_000 });
  await expect(fenetre.getByTestId("pastille-tri")).toHaveText("1");
  await expect(fenetre.getByTestId("lancer")).toBeEnabled();
  const [id] = readdirSync(dossierExecutionsDe(profil)).map((f) => f.replace(/\.json$/, ""));
  await expect(fenetre.getByTestId(`execution-${id}`)).toHaveAttribute("aria-pressed", "true");
  await expect(fenetre.getByTestId(`execution-${id}`)).toContainText("Manuelle");
  await expect(fenetre.getByTestId(`execution-${id}`)).toContainText("Réussie");
  await expect(apercu(fenetre)).toHaveText('{"liens":["Nouveau modèle IA"]}');
  expect(erreurs).toEqual([]);
  await fermer();
});

test("Rejouer depuis tri après avoir changé le seuil : essai marqué, page non relue, données, mémoire et état inchangés, aperçu de l'essai", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  // Sans état : récolté au lancement (une vraie exécution, la page lue une fois).
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(donnees(fenetre, "veille")).toHaveText('{"liens":["Nouveau modèle IA"]}', { timeout: 20_000 });
  const dossier = join(dossierWidgets(profil), "veille");
  const [origine] = readdirSync(dossierExecutionsDe(profil)).map((f) => f.replace(/\.json$/, ""));
  await ouvrirConstructeur(fenetre, "veille");
  await expect(fenetre.getByTestId(`execution-${origine}`)).toHaveAttribute("aria-pressed", "true");
  // Rien de sélectionné : rien à rejouer.
  await expect(fenetre.getByTestId("rejouer")).toBeDisabled();

  await fenetre.getByTestId("noeud-tri").click();
  const seuil = fenetre.getByTestId("volet-bloc").getByTestId("champ-seuil");
  await seuil.fill("0.05");
  await seuil.press("Enter");
  await expect.poll(() => seuilDe(join(dossierVeille(racine), "workflow.json"))).toBe(0.05);
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  const avant = {
    donnees: contenu(join(dossier, "donnees.json")),
    memoire: contenu(join(dossier, "memoire.json")),
    etat: contenu(join(dossier, "etat.json")),
  };
  expect(avant.donnees).not.toBeNull();
  const lectures = lecturesSite;
  // La récolte au lancement a bien lu le faux site : son journal compte.
  expect(lectures).toBeGreaterThan(0);

  await fenetre.getByTestId("rejouer").click();
  await expect.poll(() => readdirSync(dossierExecutionsDe(profil)).length, { timeout: 20_000 }).toBe(2);
  const essai = readdirSync(dossierExecutionsDe(profil)).find((f) => f.includes("-essai"))!.replace(/\.json$/, "");
  const bouton = fenetre.getByTestId(`execution-${essai}`);
  await expect(bouton).toContainText("essai");
  await expect(bouton).toHaveAttribute("aria-pressed", "true");
  await expect(fenetre.getByTestId("refus-rejeu")).toHaveCount(0);
  await expect(fenetre.getByTestId("pastille-liens")).toHaveClass(/neutre/);
  await expect(fenetre.getByTestId("pastille-tri")).toHaveText("2");
  await fenetre.getByTestId("bouton-apercu").click();
  await expect(apercu(fenetre)).toHaveText('{"liens":["Nouveau modèle IA","Recette de cuisine"]}');
  await expect(fenetre.getByTestId("apercu-mention")).toHaveCount(0);

  // La sortie de tri, dépliée sur l'essai, le reste quand l'essai est relu (choisir l'origine puis l'essai).
  const sortieBloc = fenetre.getByTestId("sortie-bloc");
  await sortieBloc.getByTestId("sortie-repliable").locator("summary").click();
  await expect(sortieBloc.getByTestId("sortie-json")).toBeVisible();
  await fenetre.getByTestId(`execution-${origine}`).click();
  await expect(fenetre.getByTestId(`execution-${origine}`)).toHaveAttribute("aria-pressed", "true");
  await expect(sortieBloc.getByTestId("sortie-json")).toHaveCount(0);
  await bouton.click();
  await expect(bouton).toHaveAttribute("aria-pressed", "true");
  await expect(sortieBloc.getByTestId("sortie-json")).toBeVisible();

  // La page n'a pas été relue ; ni les données, ni la mémoire, ni l'état du widget n'ont bougé.
  expect(lecturesSite).toBe(lectures);
  expect(contenu(join(dossier, "donnees.json"))).toBe(avant.donnees);
  expect(contenu(join(dossier, "memoire.json"))).toBe(avant.memoire);
  expect(contenu(join(dossier, "etat.json"))).toBe(avant.etat);

  // L'onglet « Exécutions » : toutes, l'essai marqué avec son bloc de départ ; en choisir une revient au canevas.
  await fenetre.getByTestId("vue-executions").click();
  const liste = fenetre.getByTestId("liste-executions");
  await expect(liste.getByTestId(`execution-${essai}`)).toContainText("essai depuis « tri »");
  await expect(liste.getByTestId(`execution-${origine}`)).toContainText("Planifiée");
  await liste.getByTestId(`execution-${origine}`).click();
  await expect(liste).toHaveCount(0);
  await expect(fenetre.getByTestId(`execution-${origine}`)).toHaveAttribute("aria-pressed", "true");
  await expect(apercu(fenetre)).toHaveText('{"liens":["Nouveau modèle IA"]}');
  await fermer();
});

test("Rejouer depuis un bloc dont la sortie amont est tronquée : message « Rejeu impossible : … tronquée … », aucune exécution ajoutée", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const debut = "2026-10-29T10:00:00.000Z";
  const id = "2026-10-29T10-00-00-000Z";
  const trace = (bloc: string, type: string, champs: Record<string, unknown>) => ({
    id: bloc,
    type,
    statut: "reussi",
    debut,
    fin: "2026-10-29T10:00:01.000Z",
    elements: null,
    journal: [],
    ...champs,
  });
  mkdirSync(dossierExecutionsDe(profil), { recursive: true });
  writeFileSync(
    join(dossierExecutionsDe(profil), `${id}.json`),
    JSON.stringify({
      version: 1,
      id,
      proprietaire: { type: "widget", id: "veille" },
      declencheur: "planifiee",
      debut,
      fin: "2026-10-29T10:00:02.000Z",
      statut: "reussie",
      blocs: [
        trace("page", "source.page", { sortie: { titre: "Liens" } }),
        trace("liens", "code", { elements: 2, sortie: '[{"texte":"Nouveau', sortieTronquee: true }),
        trace("tri", "ia.trier", { elements: 1, sortie: [] }),
        trace("textes", "code", { sortie: { liens: [] } }),
        trace("sortie", "sortie", { sortie: { liens: [] } }),
      ],
    }),
  );
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await ouvrirConstructeur(fenetre, "veille");
  await expect(fenetre.getByTestId(`execution-${id}`)).toHaveAttribute("aria-pressed", "true");
  await fenetre.getByTestId("noeud-tri").click();
  await fenetre.getByTestId("rejouer").click();
  await expect(fenetre.getByTestId("refus-rejeu")).toHaveText("Rejeu impossible : la sortie de « liens » a été tronquée dans cette exécution");
  await attendre(500);
  expect(readdirSync(dossierExecutionsDe(profil))).toEqual([`${id}.json`]);
  await expect(fenetre.getByTestId("rejouer")).toBeEnabled();
  await fermer();
});

test("pendant une exécution, Lancer et Rejouer sont grisés", async () => {
  const racine = nouvelleRacine();
  widgetVeilleLent(racine);
  const profil = nouveauProfil();
  // Sans état : récolté au lancement, il a une exécution à rejouer.
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(donnees(fenetre, "veille")).toHaveText('{"liens":["Nouveau modèle IA"]}', { timeout: 20_000 });
  await ouvrirConstructeur(fenetre, "veille");
  await fenetre.getByTestId("noeud-tri").click();
  await expect(fenetre.getByTestId("rejouer")).toBeEnabled();
  await expect(fenetre.getByTestId("lancer")).toBeEnabled();

  // Une exécution lancée d'ailleurs (l'agent, l'accueil) : le constructeur la voit en direct.
  await fenetre.evaluate(() => (window as unknown as { webaios: { accueil: { recolter(id: string): void } } }).webaios.accueil.recolter("veille"));
  await expect(fenetre.getByTestId("lancer")).toBeDisabled();
  await expect(fenetre.getByTestId("rejouer")).toBeDisabled();
  await expect(fenetre.getByTestId("pastille-textes")).toHaveClass(/en-cours/, { timeout: 20_000 });
  // À la fin, la vue se recale sur l'exécution écrite : plus de pastille « en cours ».
  await expect(fenetre.getByTestId("lancer")).toBeEnabled({ timeout: 20_000 });
  await expect(fenetre.getByTestId("rejouer")).toBeEnabled();
  await expect(fenetre.getByTestId("pastille-textes")).toHaveClass(/ok/);
  await expect(fenetre.getByTestId("pastille-tri")).toHaveText("1");
  await fermer();
});
