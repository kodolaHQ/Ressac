import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { appelerOutil, dossierWidgets, ecrireDisposition, ecrireEtatWidget, ecrireWidget, lancer, lireMtimes, nouveauProfil, nouvelleRacine } from "./aide";

const AUCUN_WORKFLOW = "Aucun workflow ouvert au premier plan dans le constructeur de cette fenêtre.";

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
  await w.getByRole("menuitem", { name: "Voir / modifier le workflow", exact: true }).click();
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

  // Rejouer deux fois de suite depuis tri, en partant de l'essai choisi : chaque fois un nouvel essai, jamais un refus,
  // et ses sorties reprises viennent de la vraie exécution.
  await bouton.click();
  await expect(bouton).toHaveAttribute("aria-pressed", "true");
  await fenetre.getByTestId("noeud-tri").click();
  for (const n of [3, 4]) {
    await expect(fenetre.getByTestId("rejouer")).toBeEnabled();
    await fenetre.getByTestId("rejouer").click();
    await expect.poll(() => readdirSync(dossierExecutionsDe(profil)).length, { timeout: 20_000 }).toBe(n);
    await expect(fenetre.getByTestId("refus-rejeu")).toHaveCount(0);
    const dernier = readdirSync(dossierExecutionsDe(profil)).filter((f) => f.includes("-essai")).sort().at(-1)!.replace(/\.json$/, "");
    await expect(fenetre.getByTestId(`execution-${dernier}`)).toHaveAttribute("aria-pressed", "true");
    await expect(fenetre.getByTestId("pastille-tri")).toHaveText("2");
    const e = JSON.parse(readFileSync(join(dossierExecutionsDe(profil), `${dernier}.json`), "utf8"));
    expect(e.essai).toEqual({ depart: "tri", origine });
  }
  expect(lecturesSite).toBe(lectures);
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

// Tâche 12 : l'onglet « Agent »

const terminalPanneau = (p: Page) => p.getByTestId("panneau-agent").locator(".xterm-rows");
const terminalIntegre = (p: Page) => p.getByTestId("terminal-agent-integre").locator(".xterm-rows");
/** ⌘J (le menu « Panneau agent »), comme l'utilisateur au clavier. */
const menuAgent = (app: import("@playwright/test").ElectronApplication) =>
  app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("panneau-agent")?.click());
const occurrences = async (l: Locator, texte: string) => ((await l.textContent()) ?? "").split(texte).length - 1;
const lireTexte = (chemin: string) => (existsSync(chemin) ? readFileSync(chemin, "utf8") : "");

test("l'onglet Agent montre la même conversation que le panneau, sans doublon de sortie", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  // La page d'accueil ouvre le panneau latéral : la session de la fenêtre y démarre.
  await expect(terminalPanneau(fenetre)).toContainText("faux agent prêt>");
  await fenetre.getByTestId("panneau-agent").locator(".xterm-screen").click();
  await fenetre.keyboard.type("premier");
  await fenetre.keyboard.press("Enter");
  await expect(terminalPanneau(fenetre)).toContainText("reçu: premier");

  // Dans le constructeur, le panneau latéral laisse la place à l'onglet « Agent » : le même terminal, déplacé.
  await ouvrirConstructeur(fenetre, "veille");
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await fenetre.getByTestId("palette-liste.garder").click();
  await expect(fenetre.getByTestId("noeud-liste-garder")).toBeVisible();
  await fenetre.getByTestId("onglet-agent").click();
  await expect(terminalIntegre(fenetre)).toContainText("reçu: premier");
  expect(await occurrences(terminalIntegre(fenetre), "reçu: premier")).toBe(1);
  await expect(fenetre.locator(".xterm")).toHaveCount(1);
  await fenetre.getByTestId("terminal-agent-integre").locator(".xterm-screen").click();
  await fenetre.keyboard.type("second");
  await fenetre.keyboard.press("Enter");
  await expect(terminalIntegre(fenetre)).toContainText("reçu: second");
  expect(await occurrences(terminalIntegre(fenetre), "reçu: second")).toBe(1);
  // ⌘Z tapé dans le terminal ne défait pas l'ajout du canevas.
  await fenetre.keyboard.press("Meta+z");
  await attendre(300);
  await expect(fenetre.getByTestId("noeud-liste-garder")).toHaveCount(1);
  // Une seule session pour la fenêtre : la saisie n'est arrivée qu'une fois à l'agent.
  expect(lireTexte(join(racine, "faux-agent-entree.txt")).split("second\r").length - 1).toBe(1);

  // De retour sur la page d'accueil, le panneau latéral reprend la conversation.
  await fenetre.getByTestId("nouvel-onglet").click();
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await expect(terminalPanneau(fenetre)).toContainText("reçu: second");
  expect(await occurrences(terminalPanneau(fenetre), "reçu: second")).toBe(1);
  await expect(fenetre.locator(".xterm")).toHaveCount(1);
  await fermer();
});

test("⌘J et ✦ dans le constructeur ouvrent l'onglet Agent, sans panneau latéral ni contexte pré-rempli", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { app, fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(terminalPanneau(fenetre)).toContainText("faux agent prêt>");
  await ouvrirConstructeur(fenetre, "veille");
  await expect(fenetre.getByTestId("terminal-agent-integre")).toHaveCount(0);
  await menuAgent(app);
  await expect(terminalIntegre(fenetre)).toContainText("faux agent prêt>");
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  // Retour à l'onglet « Bloc », puis le bouton ✦ : de nouveau l'onglet « Agent ».
  await fenetre.getByRole("tab", { name: "Bloc" }).click();
  await expect(fenetre.getByTestId("terminal-agent-integre")).toHaveCount(0);
  await fenetre.getByTestId("bouton-agent").click();
  await expect(terminalIntegre(fenetre)).toContainText("faux agent prêt>");
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await attendre(500);
  expect(lireTexte(join(racine, "faux-agent-entree.txt"))).toBe("");
  await fermer();
});

test("workflow_ouvert (appelerOutil avec le jeton de la session de cette fenêtre) rend le widget et le bloc sélectionné", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(terminalPanneau(fenetre)).toContainText("faux agent prêt>");
  const ouvert = async (o: { session?: boolean } = { session: true }) => (await appelerOutil(racine, "workflow_ouvert", {}, o)).texte;
  await expect.poll(() => ouvert()).toBe(AUCUN_WORKFLOW);

  await ouvrirConstructeur(fenetre, "veille");
  await expect.poll(() => ouvert()).toBe('{"widget":"veille","bloc":null}');
  await fenetre.getByTestId("noeud-tri").click();
  await expect.poll(() => ouvert()).toBe('{"widget":"veille","bloc":"tri"}');
  // L'onglet « Agent » ne change rien à ce que l'agent sait.
  await fenetre.getByTestId("onglet-agent").click();
  await expect.poll(() => ouvert()).toBe('{"widget":"veille","bloc":"tri"}');
  // Le jeton principal (sans fenêtre) ne voit aucun constructeur.
  expect(await ouvert({})).toBe(AUCUN_WORKFLOW);
  // Constructeur quitté : plus rien d'ouvert.
  await fenetre.getByTestId("nouvel-onglet").click();
  await expect.poll(() => ouvert()).toBe(AUCUN_WORKFLOW);
  await fermer();
});

test("l'agent réécrit workflow.json : le canevas montre le nouveau bloc sans changer le zoom ; avec un brouillon invalide de l'utilisateur, le bandeau propose les deux versions", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await ouvrirConstructeur(fenetre, "veille");
  await expect(fenetre.getByTestId("noeud-tri")).toBeVisible();
  // L'utilisateur zoome : la vue n'est plus celle de l'ouverture.
  const vue = fenetre.locator(".svelte-flow__viewport");
  const depart = await vue.getAttribute("style");
  await fenetre.locator(".svelte-flow__controls-zoomin").click();
  await expect.poll(() => vue.getAttribute("style")).not.toBe(depart);
  await attendre(300);
  const zoome = await vue.getAttribute("style");

  // L'agent ajoute un bloc entre « tri » et « textes ».
  const avecGarder = {
    ...WORKFLOW_VEILLE,
    blocs: [...WORKFLOW_VEILLE.blocs.slice(0, 3), { id: "garder", type: "liste.garder", parametres: { nombre: 5 } }, ...WORKFLOW_VEILLE.blocs.slice(3)],
    liens: [
      { de: "page", vers: "liens" },
      { de: "liens", vers: "tri" },
      { de: "tri", vers: "garder" },
      { de: "garder", vers: "textes" },
      { de: "textes", vers: "sortie" },
    ],
  };
  ecrireCommeAgent(racine, avecGarder);
  await expect(fenetre.getByTestId("noeud-garder")).toHaveCount(1);
  await expect(fenetre.getByTestId("bandeau-fichier")).toHaveCount(0);
  await attendre(300);
  expect(await vue.getAttribute("style")).toBe(zoome);

  // Un brouillon invalide de l'utilisateur, puis une nouvelle version de l'agent : le bandeau propose les deux.
  await fenetre.getByTestId("palette-liste.dedoublonner").click();
  await expect(fenetre.getByTestId("etat-enregistrement")).toContainText("entrée manquante");
  ecrireCommeAgent(racine, avecSeuil(0.8));
  await expect(fenetre.getByTestId("bandeau-fichier")).toBeVisible();
  await expect(fenetre.getByTestId("prendre-version")).toBeVisible();
  await expect(fenetre.getByTestId("garder-mienne")).toBeVisible();
  expect(await vue.getAttribute("style")).toBe(zoome);
  await fermer();
});

test("workflow.json illisible : pas de canevas, mais ⌘J ouvre quand même l'onglet Agent", async () => {
  const racine = nouvelleRacine();
  ecrireWidget(racine, "casse", {
    nom: "Cassé",
    recolte: { minutes: 60 },
    workflow: '{ "version": 1, "blocs": [ { "id": "page", "type": "source.pa',
    affichage: AFFICHAGE,
    exemple: { exemple: "casse" },
  });
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "casse");
  const { app, fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(terminalPanneau(fenetre)).toContainText("faux agent prêt>");
  await ouvrirConstructeur(fenetre, "casse");
  await expect(fenetre.getByTestId("workflow-illisible")).toBeVisible();
  await menuAgent(app);
  await expect(terminalIntegre(fenetre)).toContainText("faux agent prêt>");
  await fermer();
});

// Revue de la tâche 12 (fix round 1)

const saisieTerminal = (p: Page) => p.locator(".xterm-helper-textarea");
const menu = (app: import("@playwright/test").ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);

test("entrer dans le constructeur puis en sortir ne donne pas le clavier au terminal de l'agent ; ✦ le lui donne", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(terminalPanneau(fenetre)).toContainText("faux agent prêt>");
  await ouvrirConstructeur(fenetre, "veille");
  await attendre(300);
  await expect(saisieTerminal(fenetre)).not.toBeFocused();
  // Retour à la page d'accueil, qui rouvre le panneau latéral : il s'affiche sans prendre le clavier.
  await fenetre.getByTestId("nouvel-onglet").click();
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await attendre(300);
  await expect(saisieTerminal(fenetre)).not.toBeFocused();
  // Ouvert par l'utilisateur (✦) : là, le terminal prend le clavier.
  await fenetre.getByTestId("bouton-agent").click();
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await fenetre.getByTestId("bouton-agent").click();
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await expect(saisieTerminal(fenetre)).toBeFocused();
  await fermer();
});

test("panneau fermé : Agent → Bloc → Agent garde une seule conversation et un seul terminal", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(terminalPanneau(fenetre)).toContainText("faux agent prêt>");
  // L'utilisateur ferme le panneau de la page d'accueil : le terminal n'a plus d'hôte affiché en dessous de l'onglet.
  await fenetre.getByTestId("bouton-agent").click();
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await ouvrirConstructeur(fenetre, "veille");
  await fenetre.getByTestId("onglet-agent").click();
  await fenetre.getByTestId("terminal-agent-integre").locator(".xterm-screen").click();
  await fenetre.keyboard.type("un");
  await fenetre.keyboard.press("Enter");
  await expect(terminalIntegre(fenetre)).toContainText("reçu: un");
  await fenetre.getByRole("tab", { name: "Bloc" }).click();
  await expect(fenetre.getByTestId("terminal-agent-integre")).toHaveCount(0);
  await fenetre.getByTestId("onglet-agent").click();
  await fenetre.getByTestId("terminal-agent-integre").locator(".xterm-screen").click();
  await fenetre.keyboard.type("deux");
  await fenetre.keyboard.press("Enter");
  await expect(terminalIntegre(fenetre)).toContainText("reçu: deux");
  expect(await occurrences(terminalIntegre(fenetre), "reçu: un")).toBe(1);
  expect(await occurrences(terminalIntegre(fenetre), "reçu: deux")).toBe(1);
  expect(lireTexte(join(racine, "faux-agent-entree.txt"))).toBe("un\rdeux\r");
  await expect(fenetre.locator(".xterm")).toHaveCount(1);
  await fermer();
});

test("l'historique posé sur le constructeur : ⌘J le referme et ouvre l'onglet Agent", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { app, fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(terminalPanneau(fenetre)).toContainText("faux agent prêt>");
  await ouvrirConstructeur(fenetre, "veille");
  await menu(app, "historique");
  await expect(fenetre.getByTestId("historique")).toBeVisible();
  await expect(fenetre.getByTestId("constructeur")).toHaveCount(0);
  await menuAgent(app);
  await expect(fenetre.getByTestId("historique")).toHaveCount(0);
  await expect(terminalIntegre(fenetre)).toContainText("faux agent prêt>");
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await fermer();
});

// ---------------------------------------------------------------------------------------------------------------------
// Tâche 14 : de bout en bout.

test("un widget avec seulement recolte.mjs et un compte : le constructeur montre recolte → sortie ; ouvrir, sélectionner, réorganiser, choisir une exécution n'écrivent rien", async () => {
  const racine = nouvelleRacine();
  // Comme le widget Gmail de l'utilisateur : widget.json, recolte.mjs, affichage.html, un compte, pas de workflow.json.
  ecrireWidget(racine, "gmail", {
    nom: "Gmail",
    recolte: { minutes: 60 },
    sources: { compte: ["127.0.0.1"], publiques: [] },
    config: { url: `${site.url}/boite` },
    code: `export default async (webaios) => ({ vu: (await webaios.lirePage(webaios.config.url, { compte: true })).titre });`,
    affichage: AFFICHAGE,
    exemple: { exemple: "gmail" },
  });
  const profil = nouveauProfil();
  // L'accord manque et vient d'être demandé : aucune exécution ne part au lancement.
  const maintenant = new Date().toISOString();
  ecrireEtatWidget(profil, "gmail", {
    statut: "accord-requis",
    derniereMaj: maintenant,
    derniereTentative: maintenant,
    erreur: "Accord requis pour lire avec ton compte : 127.0.0.1",
    erreurNoyau: true,
  });
  // Deux exécutions passées, de quoi en choisir une autre que la dernière.
  const executions = join(dossierWidgets(profil), "gmail", "executions");
  mkdirSync(executions, { recursive: true });
  const ids = ["2026-10-28T08-00-00-000Z", "2026-10-28T09-00-00-000Z"];
  for (const id of ids) {
    const debut = id.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "T$1:$2:$3.$4Z");
    const trace = (bloc: string, type: string, sortie: unknown) => ({ id: bloc, type, statut: "reussi", debut, fin: debut, elements: null, journal: [], sortie });
    writeFileSync(
      join(executions, `${id}.json`),
      JSON.stringify({
        version: 1,
        id,
        proprietaire: { type: "widget", id: "gmail" },
        declencheur: "planifiee",
        debut,
        fin: debut,
        statut: "reussie",
        blocs: [trace("recolte", "code", { vu: id }), trace("sortie", "sortie", { vu: id })],
      }),
    );
  }
  const dossier = join(racine, "accueil", "widgets", "gmail");
  const horsEspace = join(dossierWidgets(profil), "gmail");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const erreurs = erreursConsole(fenetre);
  await expect(fenetre.getByTestId("bandeau-accord")).toContainText("127.0.0.1");
  // L'accueil posé : ce qu'il a pu écrire au lancement ne compte pas.
  await attendre(1500);
  const avant = { espace: lireMtimes(dossier), profil: lireMtimes(horsEspace) };
  expect(avant.profil.some((f) => f.startsWith("etat.json:"))).toBe(true);

  await ouvrirConstructeur(fenetre, "gmail");
  await expect(fenetre.getByTestId("noeud-recolte")).toContainText("code");
  await expect(fenetre.getByTestId("noeud-sortie")).toContainText("sortie");
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  // La dernière exécution est choisie à l'ouverture.
  await expect(fenetre.getByTestId(`execution-${ids[1]}`)).toHaveAttribute("aria-pressed", "true");

  // Sélectionner par un clic tremblé (sous le seuil de glissé de 4 px).
  const b = (await fenetre.getByTestId("noeud-recolte").boundingBox())!;
  await fenetre.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await fenetre.mouse.down();
  await fenetre.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2 + 1);
  await fenetre.mouse.up();
  await expect(fenetre.getByTestId("volet-bloc")).toBeVisible();
  await fenetre.getByTestId("noeud-sortie").click();
  // Réorganiser, puis choisir l'autre exécution.
  await fenetre.getByTestId("reorganiser").click();
  await fenetre.getByTestId(`execution-${ids[0]}`).click();
  await expect(fenetre.getByTestId(`execution-${ids[0]}`)).toHaveAttribute("aria-pressed", "true");
  await attendre(1500);

  expect(existsSync(join(dossier, "workflow.json"))).toBe(false);
  expect(lireMtimes(dossier)).toEqual(avant.espace);
  expect(lireMtimes(horsEspace)).toEqual(avant.profil);
  expect(erreurs).toEqual([]);
  await fermer();
});

test("modifier le workflow implicite crée workflow.json, garde recolte.mjs, et le widget se met à jour avec les mêmes données", async () => {
  const racine = nouvelleRacine();
  const code = "export default async () => ({ bon: true });";
  ecrireWidget(racine, "simple", { nom: "Simple", recolte: { minutes: 60 }, code, affichage: AFFICHAGE, exemple: { exemple: "simple" } });
  const profil = nouveauProfil();
  // Sans état : récolté au lancement, par recolte.mjs seul.
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(donnees(fenetre, "simple")).toHaveText('{"bon":true}', { timeout: 20_000 });
  const dossier = join(racine, "accueil", "widgets", "simple");
  const executions = join(dossierWidgets(profil), "simple", "executions");
  expect(readdirSync(executions)).toHaveLength(1);
  expect(existsSync(join(dossier, "workflow.json"))).toBe(false);

  await ouvrirConstructeur(fenetre, "simple");
  // Un vrai geste : déplacer la sortie de 80 px.
  const b = (await fenetre.getByTestId("noeud-sortie").boundingBox())!;
  await fenetre.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await fenetre.mouse.down();
  await fenetre.mouse.move(b.x + b.width / 2 + 80, b.y + b.height / 2 + 40, { steps: 10 });
  await fenetre.mouse.up();
  await expect.poll(() => existsSync(join(dossier, "workflow.json"))).toBe(true);
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  const ecrit = lireJson(join(dossier, "workflow.json"));
  expect(ecrit.blocs.map((x: { id: string; type: string }) => `${x.id}:${x.type}`)).toEqual(["recolte:code", "sortie:sortie"]);
  expect(ecrit.blocs[0].parametres).toMatchObject({ source: "recolte.mjs" });
  expect(ecrit.liens).toEqual([{ de: "recolte", vers: "sortie" }]);
  expect(readFileSync(join(dossier, "recolte.mjs"), "utf8")).toBe(code);

  // Le widget passe désormais par workflow.json : mêmes données.
  await fenetre.getByTestId("nouvel-onglet").click();
  await expect(donnees(fenetre, "simple")).toHaveText('{"bon":true}');
  await fenetre.evaluate(() => (window as unknown as { webaios: { accueil: { recolter(id: string): void } } }).webaios.accueil.recolter("simple"));
  await expect.poll(() => readdirSync(executions).length, { timeout: 20_000 }).toBe(2);
  const derniere = lireJson(join(executions, readdirSync(executions).sort().at(-1)!));
  expect(derniere.statut).toBe("reussie");
  expect(derniere.declencheur).toBe("manuelle");
  await expect(donnees(fenetre, "simple")).toHaveText('{"bon":true}');
  expect(lireJson(join(dossierWidgets(profil), "simple", "donnees.json"))).toEqual({ bon: true });
  expect(lireJson(join(dossierWidgets(profil), "simple", "etat.json")).statut).toBe("ok");
  await fermer();
});

test("l'agent écrit un workflow.json coupé : le canevas reste, le bandeau dit « illisible », le widget affiche « Workflow invalide : … »", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const fichier = join(dossierVeille(racine), "workflow.json");
  await ouvrirConstructeur(fenetre, "veille");
  await expect(fenetre.getByTestId("noeud-tri")).toBeVisible();

  // L'agent écrit sans passer par un fichier temporaire : JSON coupé en plein milieu.
  const coupe = JSON.stringify(WORKFLOW_VEILLE).slice(0, 120);
  writeFileSync(fichier, coupe);
  const bandeau = fenetre.getByTestId("bandeau-fichier");
  await expect(bandeau).toContainText("illisible");
  for (const id of ["page", "liens", "tri", "textes", "sortie"]) await expect(fenetre.getByTestId(`noeud-${id}`)).toBeVisible();
  await expect(fenetre.getByTestId("workflow-illisible")).toHaveCount(0);
  await attendre(500);
  // Le constructeur n'a pas réécrit par-dessus.
  expect(readFileSync(fichier, "utf8")).toBe(coupe);

  // Sur l'accueil, la récolte suivante le dit sur le widget.
  await fenetre.getByTestId("nouvel-onglet").click();
  await fenetre.evaluate(() => (window as unknown as { webaios: { accueil: { recolter(id: string): void } } }).webaios.accueil.recolter("veille"));
  await expect(fenetre.getByTestId("widget-veille")).toContainText("Workflow invalide : ", { timeout: 20_000 });
  expect(lireJson(join(dossierWidgets(profil), "veille", "etat.json")).erreur).toMatch(/^Workflow invalide : /);
  await fermer();
});

/** 30 blocs : six sources de code, chacune suivie de trois listes, réunies puis triées et mises en forme. */
function workflowTrenteBlocs(): { workflow: unknown; fichiers: Record<string, string> } {
  const blocs: { id: string; type: string; parametres: Record<string, unknown> }[] = [];
  const liens: { de: string; vers: string }[] = [];
  const fichiers: Record<string, string> = {};
  for (let i = 1; i <= 6; i++) {
    blocs.push({ id: `source-${i}`, type: "code", parametres: { source: `source-${i}.mjs` } });
    fichiers[`source-${i}.mjs`] = `export default async () => [{ url: "https://exemple.invalid/${i}" }];`;
    blocs.push({ id: `nouveaux-${i}`, type: "liste.nouveaux", parametres: { cle: "url" } });
    blocs.push({ id: `dedoublonner-${i}`, type: "liste.dedoublonner", parametres: { cles: ["url"] } });
    blocs.push({ id: `garder-${i}`, type: "liste.garder", parametres: { nombre: 10 } });
    liens.push({ de: `source-${i}`, vers: `nouveaux-${i}` }, { de: `nouveaux-${i}`, vers: `dedoublonner-${i}` }, { de: `dedoublonner-${i}`, vers: `garder-${i}` });
    liens.push({ de: `garder-${i}`, vers: "fusion" });
  }
  blocs.push(
    { id: "fusion", type: "code", parametres: { source: "fusion.mjs" } },
    { id: "tri", type: "ia.trier", parametres: { question: "Parle d'IA ?", texte: "{url}", seuil: 0.5 } },
    { id: "garder", type: "liste.garder", parametres: { nombre: 20 } },
    { id: "dedoublonner", type: "liste.dedoublonner", parametres: { cles: ["url"] } },
    { id: "forme", type: "code", parametres: { source: "forme.mjs" } },
    { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
  );
  fichiers["fusion.mjs"] = "export default async (entrees) => Object.values(entrees).flat();";
  fichiers["forme.mjs"] = "export default async (liens) => ({ liens });";
  liens.push({ de: "fusion", vers: "tri" }, { de: "tri", vers: "garder" }, { de: "garder", vers: "dedoublonner" }, { de: "dedoublonner", vers: "forme" }, { de: "forme", vers: "sortie" });
  return { workflow: { version: 1, blocs, liens }, fichiers };
}

test("un workflow de 30 blocs s'ouvre lisible : aucun nœud ne se chevauche, tous dans la vue après fitView", async () => {
  const racine = nouvelleRacine();
  const { workflow, fichiers } = workflowTrenteBlocs();
  expect((workflow as { blocs: unknown[] }).blocs).toHaveLength(30);
  ecrireWidget(racine, "grand", { nom: "Grand", recolte: { minutes: 60 }, workflow, fichiers, affichage: AFFICHAGE, exemple: { exemple: "grand" } });
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "grand");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const avant = instantane(join(racine, "accueil", "widgets", "grand"));
  await ouvrirConstructeur(fenetre, "grand");
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
  const noeuds = fenetre.locator('[data-testid^="noeud-"]');
  await expect(noeuds).toHaveCount(30);
  await attendre(500);
  const vue = (await fenetre.locator(".svelte-flow").boundingBox())!;
  const boites: Boite[] = [];
  for (const n of await noeuds.all()) boites.push((await n.boundingBox())!);
  for (const [i, a] of boites.entries()) {
    expect(a.x, `nœud ${i} à gauche de la vue`).toBeGreaterThanOrEqual(vue.x);
    expect(a.y, `nœud ${i} au-dessus de la vue`).toBeGreaterThanOrEqual(vue.y);
    expect(a.x + a.width, `nœud ${i} à droite de la vue`).toBeLessThanOrEqual(vue.x + vue.width);
    expect(a.y + a.height, `nœud ${i} sous la vue`).toBeLessThanOrEqual(vue.y + vue.height);
  }
  for (let i = 0; i < boites.length; i++) for (let j = i + 1; j < boites.length; j++) expect(chevauchent(boites[i]!, boites[j]!), `nœuds ${i} et ${j}`).toBe(false);
  // Disposé à l'ouverture sans rien écrire.
  expect(instantane(join(racine, "accueil", "widgets", "grand"))).toEqual(avant);
  await fermer();
});

// Tâche 15 (plan 10) : la veille dans le constructeur

/** État « à jour » dont le suivi des heures dit tout fait : aucune heure n'est due pendant le test. */
const etatSansHeureDue = () => {
  const maintenant = new Date().toISOString();
  return { statut: "ok", derniereMaj: maintenant, derniereTentative: maintenant, heures: { faite: "9999-12-31T23:59", echecs: null } };
};

test("le panneau Widget d'un widget web affiche « Accès au web : ouvert » et ses heures ; Chercher sur le web s'ajoute depuis la palette", async () => {
  const racine = nouvelleRacine();
  ecrireWidget(racine, "veille", {
    nom: "Veille",
    recolte: { heures: ["07:00", "19:00"], dureeMaxMinutes: 30, notifier: true },
    sources: { web: true },
    config: { url: `${site.url}/liens` },
    workflow: WORKFLOW_VEILLE,
    fichiers: {
      "liens.mjs": "export default async (page) => page.liens;",
      "textes.mjs": "export default async (liens) => ({ liens: liens.map((l) => l.texte) });",
    },
    affichage: AFFICHAGE,
    exemple: { exemple: "veille" },
  });
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille", etatSansHeureDue());
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const declaration = readFileSync(join(dossierVeille(racine), "widget.json"), "utf8");
  await ouvrirConstructeur(fenetre, "veille");
  const panneau = fenetre.getByTestId("panneau-widget");
  await expect(fenetre.getByTestId("widget-web")).toHaveText("Accès au web : ouvert");
  await expect(fenetre.getByTestId("widget-heures")).toHaveText("Heures prévues : 07:00, 19:00");
  await expect(panneau).toContainText("Durée maximale : 30 min");
  await expect(panneau).toContainText("Notification à la fin : oui");

  const chercher = fenetre.getByTestId("palette-web.chercher");
  await expect(chercher).toBeEnabled();
  await chercher.click();
  await expect(fenetre.getByTestId("noeud-web-chercher")).toBeVisible();
  await expect(fenetre.getByTestId("etat-enregistrement")).not.toContainText("doit déclarer");
  // widget.json n'est jamais écrit par le constructeur.
  expect(readFileSync(join(dossierVeille(racine), "widget.json"), "utf8")).toBe(declaration);
  await fermer();
});

test("dans un widget sans web, Chercher sur le web est grisé ; un web.chercher écrit par l'agent rend « Non enregistré » / « Workflow invalide : web.chercher … »", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await ouvrirConstructeur(fenetre, "veille");
  await expect(fenetre.getByTestId("noeud-tri")).toBeVisible();
  // Rien sur le web dans le panneau d'un widget sans accès.
  await expect(fenetre.getByTestId("widget-web")).toHaveCount(0);
  await expect(fenetre.getByTestId("widget-heures")).toHaveCount(0);
  const chercher = fenetre.getByTestId("palette-web.chercher");
  await expect(chercher).toBeDisabled();
  await expect(chercher).toHaveAttribute("title", 'Le widget doit déclarer "web": true : demande-le à l\'agent.');
  await chercher.click({ force: true });
  await expect(fenetre.getByTestId("noeud-web-chercher")).toHaveCount(0);

  ecrireCommeAgent(racine, {
    version: 1,
    blocs: [
      { id: "chercher", type: "web.chercher", parametres: { requete: "voitures" } },
      { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
    ],
    liens: [{ de: "chercher", vers: "sortie" }],
  });
  await expect(fenetre.getByTestId("noeud-chercher")).toBeVisible();
  await expect(fenetre.getByTestId("etat-enregistrement")).toContainText("Non enregistré : ");
  await expect(fenetre.getByTestId("etat-enregistrement")).toContainText('Workflow invalide : web.chercher : le widget doit déclarer "web": true');
  await fermer();
});

test("auFilDeLEau derrière Garder les N premiers : avertissement sur la sortie", async () => {
  const racine = nouvelleRacine();
  ecrireWidget(racine, "veille", {
    nom: "Veille",
    recolte: { minutes: 60 },
    config: { url: `${site.url}/liens` },
    workflow: {
      version: 1,
      blocs: [
        { id: "page", type: "source.page", parametres: { url: "{config.url}" } },
        { id: "liens", type: "code", parametres: { source: "liens.mjs" } },
        { id: "garder", type: "liste.garder", parametres: { nombre: 5 } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget", auFilDeLEau: true } },
      ],
      liens: [
        { de: "page", vers: "liens" },
        { de: "liens", vers: "garder" },
        { de: "garder", vers: "sortie" },
      ],
    },
    fichiers: { "liens.mjs": "export default async (page) => page.liens;" },
    affichage: AFFICHAGE,
    exemple: { exemple: "veille" },
  });
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const fichier = join(dossierVeille(racine), "workflow.json");
  await ouvrirConstructeur(fenetre, "veille");
  await fenetre.getByTestId("noeud-sortie").click();
  await expect(fenetre.getByTestId("avertissement-sortie")).toContainText(
    "rien à publier au fil de l'eau : l'entrée de la sortie n'est pas traitée élément par élément",
  );
  await expect(fenetre.getByTestId("noeud-sortie")).toHaveClass(/avertit/);
  await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");

  // Décochée, la case retire la clé (absente = faux) : rien d'autre n'est écrit dans la sortie.
  const caseFil = fenetre.getByTestId("champ-auFilDeLEau");
  await expect(caseFil).toBeChecked();
  await caseFil.uncheck();
  await expect.poll(() => lireJson(fichier).blocs.find((b: { id: string }) => b.id === "sortie").parametres).toEqual({ vers: "widget" });
  await expect(fenetre.getByTestId("avertissement-sortie")).toHaveCount(0);
  await fermer();
});

// ---------------------------------------------------------------------------------------------------------------------
// Le constructeur ouvert sur une action (webaios://workflow/action/<id>) : panneau Action, ▶ Lancer avec la saisie,
// rejeu dont la page s'affiche dans l'aperçu sans devenir le dernier résultat. Gemma absente : mise en page de secours.

const CONSIGNE_GITLAB = "Un tableau des tickets, les plus urgents d'abord";

/** Une action à saisie : un bloc `code` qui rend la saisie (et `marque`), puis la sortie vers la page. */
function actionGitlab(racine: string, marque = "un"): string {
  const dossier = join(racine, "actions", "gitlab");
  mkdirSync(dossier, { recursive: true });
  writeFileSync(
    join(dossier, "action.json"),
    JSON.stringify({ nom: "Tickets GitLab", saisie: { libelle: "Projet" }, sources: { publiques: ["gitlab.com"] }, miseEnPage: CONSIGNE_GITLAB, dureeMaxMinutes: 5 }),
  );
  writeFileSync(
    join(dossier, "workflow.json"),
    JSON.stringify({
      version: 1,
      blocs: [
        { id: "lire", type: "code", parametres: { source: "lire.mjs" } },
        { id: "sortie", type: "sortie", parametres: { vers: "page" } },
      ],
      liens: [{ de: "lire", vers: "sortie" }],
    }),
  );
  codeGitlab(racine, marque);
  return dossier;
}
const codeGitlab = (racine: string, marque: string) =>
  writeFileSync(join(racine, "actions", "gitlab", "lire.mjs"), `export default async (_e, w) => [{ titre: "ticket-" + w.saisie + "-${marque}" }];`);
const executionsAction = (profil: string, id: string) => {
  const d = join(profil, "actions", id, "executions");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).sort() : [];
};

/** Attend que le noyau serve les actions, puis ouvre le constructeur de l'action par sa page (« Voir le workflow »). */
async function ouvrirConstructeurAction(fenetre: Page, id: string, nom: string): Promise<Locator> {
  await expect
    .poll(() => fenetre.evaluate(() => window.webaios.actions.lancer("inconnue-du-test", null).then((r) => r.erreur ?? "")), { timeout: 30_000 })
    .not.toContain("agent arrêté");
  await fenetre.evaluate(([id, nom]) => window.webaios.agir({ type: "ouvrirAction", fenetreId: window.webaios.fenetreId, id, nom }), [id, nom] as const);
  await expect(fenetre.getByTestId("page-action")).toBeVisible();
  await fenetre.getByTestId("voir-workflow").click();
  const page = fenetre.getByTestId("constructeur");
  await expect(page).toBeVisible();
  return page;
}

test("ouvrir le workflow d'une action depuis sa page : panneau Action avec saisie et consigne", async () => {
  const racine = nouvelleRacine();
  const dossier = actionGitlab(racine);
  const avant = instantane(dossier);
  const { fenetre, fermer } = await lancerWidgets(racine);
  try {
    await expect(terminalPanneau(fenetre)).toContainText("faux agent prêt>");
    const page = await ouvrirConstructeurAction(fenetre, "gitlab", "Tickets GitLab");
    await expect(fenetre.locator('[data-testid^="onglet-"]').filter({ hasText: "Workflow — Tickets GitLab" })).toHaveCount(1);
    await expect(page.locator("h1")).toHaveText("Tickets GitLab");
    await expect(fenetre.getByTestId("noeud-lire")).toBeVisible();
    await expect(fenetre.getByTestId("etat-enregistrement")).toHaveText("Enregistré");
    // Rien de sélectionné : le panneau Action (lecture seule) à la place de celui du widget.
    const panneau = fenetre.getByTestId("panneau-action");
    await expect(panneau).toBeVisible();
    await expect(fenetre.getByTestId("panneau-widget")).toHaveCount(0);
    await expect(panneau.getByTestId("action-compte")).toHaveText("aucun");
    await expect(panneau.getByTestId("action-publiques")).toHaveText("gitlab.com");
    await expect(panneau.getByTestId("action-saisie")).toHaveText("Projet");
    await expect(panneau.getByTestId("action-mise-en-page")).toHaveText(CONSIGNE_GITLAB);
    await expect(panneau).toContainText("Durée maximale : 5 min");
    await expect(fenetre.getByTestId("bouton-apercu")).toHaveText("Aperçu de la page");
    // Action sans accès au web : la palette le dit pour une action (action.json), pas pour un widget.
    const chercher = fenetre.getByTestId("palette-web.chercher");
    await expect(chercher).toBeDisabled();
    await expect(chercher).toHaveAttribute("title", 'L\'action doit déclarer "web": true dans ses sources (action.json) : demande-le à l\'agent.');
    // L'agent sait que c'est le workflow de l'action, et le bloc choisi.
    const ouvert = async () => (await appelerOutil(racine, "workflow_ouvert", {}, { session: true })).texte;
    await expect.poll(ouvert).toBe('{"action":"gitlab","bloc":null}');
    await fenetre.getByTestId("noeud-lire").click();
    await expect.poll(ouvert).toBe('{"action":"gitlab","bloc":"lire"}');
    // Ouvrir et sélectionner n'écrivent rien dans le dossier de l'action.
    expect(instantane(dossier)).toEqual(avant);
  } finally {
    await fermer();
  }
});

test("▶ Lancer demande la saisie, puis l'exécution apparaît dans la liste", async () => {
  const racine = nouvelleRacine();
  actionGitlab(racine);
  const profil = nouveauProfil();
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  try {
    await ouvrirConstructeurAction(fenetre, "gitlab", "Tickets GitLab");
    await expect(fenetre.getByText("Aucune exécution pour l'instant.")).toBeVisible();
    await fenetre.getByTestId("lancer").click();
    const demande = fenetre.getByTestId("demande-saisie");
    await expect(demande).toBeVisible();
    await expect(demande).toContainText("Projet");
    // Saisie vide : rien n'est lancé.
    await expect(demande.getByTestId("confirmer-lancer")).toBeDisabled();
    // Échap ferme la demande sans rien lancer.
    await demande.getByTestId("saisie-lancer").press("Escape");
    await expect(demande).toHaveCount(0);
    expect(executionsAction(profil, "gitlab")).toEqual([]);
    await fenetre.getByTestId("lancer").click();
    await fenetre.getByTestId("saisie-lancer").fill("webaios");
    await fenetre.getByTestId("saisie-lancer").press("Enter");
    await expect(fenetre.getByTestId("demande-saisie")).toHaveCount(0);
    await expect.poll(() => executionsAction(profil, "gitlab"), { timeout: 60_000 }).toHaveLength(1);
    const id = executionsAction(profil, "gitlab")[0]!.replace(/\.json$/, "");
    const bouton = fenetre.getByTestId(`execution-${id}`);
    await expect(bouton).toBeVisible({ timeout: 30_000 });
    await expect(bouton).toHaveAttribute("aria-pressed", "true");
    await expect(bouton).toContainText("Manuelle");
    await expect(fenetre.getByTestId("pastille-lire")).toHaveText("1");
    const e = lireJson(join(profil, "actions", "gitlab", "executions", `${id}.json`));
    expect(e).toMatchObject({ declencheur: "manuelle", saisie: "webaios", statut: "reussie" });
    // L'aperçu montre la page de cette exécution (les composants de l'agent n'y sont jamais chargés).
    await fenetre.getByTestId("bouton-apercu").click();
    await expect(fenetre.getByTestId("apercu-action")).toContainText("ticket-webaios-un", { timeout: 30_000 });
  } finally {
    await fermer();
  }
});

test("rejouer depuis un bloc : l'aperçu montre une page, le dernier résultat de la page de l'action ne change pas", async () => {
  const racine = nouvelleRacine();
  actionGitlab(racine, "un");
  const profil = nouveauProfil();
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  try {
    await ouvrirConstructeurAction(fenetre, "gitlab", "Tickets GitLab");
    // Une vraie exécution, lancée depuis la page (sa saisie : « webaios »).
    const vraie = await fenetre.evaluate(() => window.webaios.actions.lancer("gitlab", "webaios"));
    expect(vraie.statut).toBe("reussie");
    const origine = vraie.execution!;
    await expect(fenetre.getByTestId(`execution-${origine}`)).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
    // Le code change : l'essai le montre, la vraie exécution non.
    codeGitlab(racine, "deux");
    await fenetre.getByTestId("noeud-lire").click();
    await expect(fenetre.getByTestId("rejouer")).toBeEnabled();
    await fenetre.getByTestId("rejouer").click();
    await expect.poll(() => executionsAction(profil, "gitlab").filter((f) => f.includes("-essai")), { timeout: 60_000 }).toHaveLength(1);
    const essai = executionsAction(profil, "gitlab").find((f) => f.includes("-essai"))!.replace(/\.json$/, "");
    const bouton = fenetre.getByTestId(`execution-${essai}`);
    await expect(bouton).toContainText("essai", { timeout: 30_000 });
    await expect(bouton).toHaveAttribute("aria-pressed", "true");
    await expect(fenetre.getByTestId("refus-rejeu")).toHaveCount(0);
    await fenetre.getByTestId("bouton-apercu").click();
    const apercuAction = fenetre.getByTestId("apercu-action");
    await expect(apercuAction.getByTestId("rendu-page")).toBeVisible({ timeout: 30_000 });
    // L'essai reprend la saisie de l'exécution d'origine.
    await expect(apercuAction).toContainText("ticket-webaios-deux");
    // Choisir la vraie exécution : l'aperçu montre sa page.
    await fenetre.getByTestId(`execution-${origine}`).click();
    await expect(apercuAction).toContainText("ticket-webaios-un");
    // Le dernier résultat de l'action reste la vraie exécution : sa page ne montre pas l'essai.
    const derniere = await fenetre.evaluate(() => window.webaios.actions.page("gitlab", null));
    expect(derniere?.execution).toBe(origine);
    await fenetre.evaluate(() => window.webaios.agir({ type: "ouvrirAction", fenetreId: window.webaios.fenetreId, id: "gitlab", nom: "Tickets GitLab" }));
    await expect(fenetre.getByTestId("page-action").getByTestId("rendu-page")).toContainText("ticket-webaios-un");
    await expect(fenetre.getByTestId("page-action")).not.toContainText("ticket-webaios-deux");
  } finally {
    await fermer();
  }
});
