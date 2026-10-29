import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
let kev: Serveur;
let ollama: Serveur;

test.beforeAll(async () => {
  site = await ecouter((_req, res) => {
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

/** « Voir le workflow » par le menu du widget : le constructeur s'ouvre dans un onglet. */
async function ouvrirConstructeur(fenetre: Page, id: string): Promise<Locator> {
  const w = fenetre.getByTestId(`widget-${id}`);
  await w.getByRole("button", { name: "Options du widget" }).click();
  await w.getByRole("menuitem", { name: "Voir le workflow" }).click();
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
