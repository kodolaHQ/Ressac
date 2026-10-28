import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { createSocket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dossierWidgets,
  ecrireDisposition,
  ecrireEtatWidget,
  ecrireWidget,
  lancer,
  lireDisposition,
  nouveauProfil,
  nouvelleRacine,
  ouvrirOnglet,
  reglerEspaceActifPrive,
} from "./aide";

const onglets = '[data-testid^="onglet-"]';
const MODELES = join(__dirname, "..", "..", "..", "packages", "noyau", "modeles", "widgets");

// ---------------------------------------------------------------------------------------------------------------------
// Serveurs de test : tout est local, rien ne sort de la machine. Chaque serveur note ce qu'il reçoit.

interface Requete {
  chemin: string;
  cookie: string | undefined;
}
interface Serveur {
  url: string;
  port: number;
  journal: Requete[];
  fermer(): Promise<void>;
}

async function ecouter(gerer: (req: IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<Serveur> {
  const journal: Requete[] = [];
  const serveur = createServer((req, res) => {
    journal.push({ chemin: req.url ?? "/", cookie: req.headers.cookie });
    gerer(req, res);
  });
  // Un WebSocket n'arrive pas par « request » : il est noté aussi.
  serveur.on("upgrade", (req, socket) => {
    journal.push({ chemin: `upgrade ${req.url ?? "/"}`, cookie: req.headers.cookie });
    socket.destroy();
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  const port = (serveur.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    journal,
    fermer: () =>
      new Promise((ok) => {
        serveur.closeAllConnections();
        serveur.close(() => ok());
      }),
  };
}

const html = (res: import("node:http").ServerResponse, corps: string) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(corps);
};

/** Le site lu par les widgets (127.0.0.1) ; `autre` est un autre hôte (localhost) où il ne doit jamais mener. */
let site: Serveur;
let autre: Serveur;
let kev: Serveur & { appels: string[] };
let ollama: Serveur;

test.beforeAll(async () => {
  autre = await ecouter((_req, res) => html(res, "<title>Autre</title>"));
  const ailleurs = (chemin: string) => `http://localhost:${autre.port}${chemin}`;
  site = await ecouter((req, res) => {
    const chemin = new URL(req.url ?? "/", "http://x").pathname;
    switch (chemin) {
      case "/cookie":
        res.writeHead(200, { "Set-Cookie": "essai=1; Max-Age=86400; Path=/", "Content-Type": "text/html" });
        return res.end("<title>cookie</title>ok");
      case "/lire-cookie":
        return html(res, `<title>${req.headers.cookie ?? "aucun"}</title>`);
      case "/liens":
        return html(
          res,
          '<title>Liens</title><a href="https://exemple.invalid/ia">Nouveau modèle IA</a> <a href="https://exemple.invalid/cuisine">Recette de cuisine</a>',
        );
      case "/r302":
        res.writeHead(302, { Location: ailleurs("/r302") });
        return res.end();
      case "/js":
        return html(res, `<title>js</title><script>location = ${JSON.stringify(ailleurs("/js"))}</script>`);
      case "/meta":
        return html(res, `<title>meta</title><meta http-equiv="refresh" content="0;url=${ailleurs("/meta")}">`);
      case "/imprime":
        return html(res, "<title>imprimé</title><script>print()</script><p>après</p>");
      case "/alerte":
        return html(res, "<title>alerté</title><script>alert('coucou')</script><p>après</p>");
      default:
        return html(res, "<title>ok</title>");
    }
  });
  // Faux Kev : une note haute pour un texte qui parle d'IA, basse sinon.
  const appels: string[] = [];
  const serveurKev = await ecouter((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"data":[]}');
    let corps = "";
    req.on("data", (d) => (corps += d));
    req.on("end", () => {
      const { state } = JSON.parse(corps) as { state: string };
      appels.push(state);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers: { q: { noul: /\bIA\b/.test(state) ? 0.9 : 0.1 } } }));
    });
  });
  kev = Object.assign(serveurKev, { appels });
  // Faux Ollama : répond, mais sans le modèle Gemma.
  ollama = await ecouter((_req, res) => void res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}'));
});
test.afterAll(async () => {
  await Promise.all([site, autre, kev, ollama].map((s) => s?.fermer()));
});

/** Variables des tests de widgets : faux Kev et faux Ollama, et récoltes permises vers le serveur de test local. */
const envWidgets = () => ({
  WEBAIOS_KEV_URL: kev.url,
  WEBAIOS_OLLAMA_URL: ollama.url,
  WEBAIOS_TEST_ADRESSES_LOCALES: "1",
});

/** Lance l'app sur cet espace et ce profil, avec les faux serveurs d'IA. */
const lancerWidgets = (racine: string, profil = nouveauProfil()) => lancer({ racine, profil, env: envWidgets() });

// ---------------------------------------------------------------------------------------------------------------------
// Affichages de test

/** Affiche ce qu'il reçoit : les données (JSON), le statut et le nombre de messages reçus du parent. */
const AFFICHAGE = `<!doctype html><meta charset="utf-8">
<pre id="donnees"></pre><span id="statut"></span> <span id="messages">0</span>
<script>
  let n = 0;
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.type !== "widget") return;
    n++;
    document.getElementById("donnees").textContent = JSON.stringify(e.data.donnees);
    document.getElementById("statut").textContent = e.data.etat.statut;
    document.getElementById("messages").textContent = String(n);
  });
</script>`;

const cadre = (fenetre: Page, id: string) => fenetre.frameLocator(`[data-testid="widget-${id}"] iframe`);
const donnees = (fenetre: Page, id: string) => cadre(fenetre, id).locator("#donnees");

/** « Mettre à jour maintenant » par le menu du widget. */
async function recolter(fenetre: Page, id: string): Promise<void> {
  const w = fenetre.getByTestId(`widget-${id}`);
  await w.getByRole("button", { name: "Options du widget" }).click();
  await w.getByRole("menuitem", { name: "Mettre à jour maintenant" }).click();
}

const lireJson = (chemin: string) => JSON.parse(readFileSync(chemin, "utf8"));
const accords = (profil: string) => {
  const f = join(dossierWidgets(profil), "accords.json");
  return existsSync(f) ? lireJson(f) : {};
};

/** Le relâchement du clic ne rend parfois pas la main quand un onglet s'ouvre par-dessus : on ne l'attend pas. */
async function cliquer(fenetre: Page, cible: import("@playwright/test").Locator): Promise<void> {
  const b = (await cible.boundingBox())!;
  await fenetre.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await fenetre.mouse.down();
  void fenetre.mouse.up().catch(() => {});
}

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------

test("la page d'accueil place les widgets selon disposition.json et affiche exemple.json tant qu'aucune récolte n'a réussi", async () => {
  const racine = nouvelleRacine();
  ecrireWidget(racine, "un", { nom: "Un", affichage: AFFICHAGE, exemple: { exemple: "un" } });
  ecrireWidget(racine, "deux", { nom: "Deux", affichage: AFFICHAGE, exemple: { exemple: "deux" } });
  // Un widget de départ (filtre `e.source === parent`) reçoit bien les messages de la page.
  ecrireWidget(racine, "meteo", {
    nom: "Météo",
    affichage: readFileSync(join(MODELES, "meteo", "affichage.html"), "utf8"),
    exemple: lireJson(join(MODELES, "meteo", "exemple.json")),
  });
  ecrireWidget(racine, "sans-affichage", { nom: "Sans affichage" });
  ecrireDisposition(racine, [
    { id: "un", x: 0, y: 0, l: 3, h: 2 },
    { id: "deux", x: 6, y: 1, l: 4, h: 3 },
    { id: "meteo", x: 0, y: 4, l: 3, h: 2 },
    { id: "sans-affichage", x: 4, y: 4, l: 2, h: 2 },
  ]);
  const profil = nouveauProfil();
  // Une récolte déjà en échec (données absentes) : l'exemple reste affiché, le badge dit l'échec.
  ecrireEtatWidget(profil, "deux", { statut: "erreur", derniereMaj: null, derniereTentative: new Date().toISOString(), erreur: "Délai dépassé", erreurNoyau: true });
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(fenetre.getByTestId("accueil")).toBeVisible();
  await expect(fenetre.locator('[data-testid="titre-widget"]')).toHaveText(["Un", "Deux", "Météo", "Sans affichage"]);
  await expect(donnees(fenetre, "un")).toHaveText('{"exemple":"un"}');
  await expect(donnees(fenetre, "deux")).toHaveText('{"exemple":"deux"}');
  await expect(fenetre.getByTestId("widget-deux")).toContainText("Délai dépassé");
  await expect(cadre(fenetre, "meteo").locator("#ville")).toHaveText("Bordeaux");
  await expect(fenetre.getByTestId("widget-sans-affichage")).toContainText("pas encore écrit l'affichage");

  // Les places : 12 colonnes, rangées de 90 px, 12 px d'écart.
  const grille = (await fenetre.getByTestId("accueil").boundingBox())!;
  const colonne = (grille.width - 11 * 12) / 12;
  const boite = async (id: string) => (await fenetre.getByTestId(`widget-${id}`).boundingBox())!;
  const un = await boite("un");
  const deux = await boite("deux");
  expect(Math.abs(un.x - grille.x)).toBeLessThan(2);
  expect(Math.abs(un.y - grille.y)).toBeLessThan(2);
  expect(Math.abs(un.width - (3 * colonne + 2 * 12))).toBeLessThan(2);
  expect(Math.abs(un.height - (2 * 90 + 12))).toBeLessThan(2);
  expect(Math.abs(deux.x - (grille.x + 6 * (colonne + 12)))).toBeLessThan(2);
  expect(Math.abs(deux.y - (grille.y + 102))).toBeLessThan(2);
  expect(Math.abs(deux.width - (4 * colonne + 3 * 12))).toBeLessThan(2);
  expect(Math.abs(deux.height - (3 * 90 + 2 * 12))).toBeLessThan(2);
  await fermer();
});

test("une récolte réussie met à jour l'affichage sans recharger la page", async () => {
  const racine = nouvelleRacine();
  ecrireWidget(racine, "tri", {
    nom: "Tri",
    recolte: { minutes: 60 },
    config: { url: `${site.url}/liens` },
    code: `export default async (webaios) => {
  const page = await webaios.lirePage(webaios.config.url);
  const gardes = await webaios.trier(page.liens, { question: "Parle d'IA ?", texte: (l) => l.texte });
  return { titre: page.titre, liens: gardes.map((g) => g.element.texte) };
};`,
    affichage: AFFICHAGE,
    exemple: { exemple: true },
  });
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "tri"); // à jour : pas de récolte au lancement, l'exemple s'affiche
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(donnees(fenetre, "tri")).toHaveText('{"exemple":true}');
  await fenetre.evaluate(() => ((window as unknown as { marque: string }).marque = "toujours là"));
  await recolter(fenetre, "tri");
  await expect(donnees(fenetre, "tri")).toHaveText('{"titre":"Liens","liens":["Nouveau modèle IA"]}', { timeout: 20_000 });
  await expect(cadre(fenetre, "tri").locator("#statut")).toHaveText("ok");
  // Ni la page ni le cadre n'ont été rechargés : la marque est là, le cadre a reçu plusieurs messages.
  expect(await fenetre.evaluate(() => (window as unknown as { marque?: string }).marque)).toBe("toujours là");
  expect(Number(await cadre(fenetre, "tri").locator("#messages").textContent())).toBeGreaterThanOrEqual(2);
  expect(kev.appels).toEqual(expect.arrayContaining(["Nouveau modèle IA", "Recette de cuisine"]));
  expect(lireJson(join(dossierWidgets(profil), "tri", "donnees.json"))).toEqual({ titre: "Liens", liens: ["Nouveau modèle IA"] });
  await fermer();
});

/** « liens » ouvre un lien à chaque clic sur #lien (et javascript: sur #js) ; « sans-clic » et « focus » en demandent seuls. */
function widgetsLiens(racine: string): void {
  ecrireWidget(racine, "liens", {
    nom: "Liens",
    affichage: `<!doctype html><meta charset="utf-8">
<button id="lien" style="width:200px;height:50px">Ouvrir</button>
<button id="js" style="width:200px;height:50px">JS</button>
<script>
  let n = 0;
  document.getElementById("lien").onclick = () => parent.postMessage({ type: "ouvrir", url: "https://exemple.invalid/lien-" + ++n }, "*");
  document.getElementById("js").onclick = () => parent.postMessage({ type: "ouvrir", url: "javascript:alert(1)" }, "*");
</script>`,
  });
  // Sans clic : au chargement, sur une minuterie, en boucle.
  ecrireWidget(racine, "sans-clic", {
    nom: "Sans clic",
    affichage: `<!doctype html><p id="pret">prêt</p><script>
  const ouvrir = (u) => parent.postMessage({ type: "ouvrir", url: "https://exemple.invalid/" + u }, "*");
  ouvrir("chargement");
  setTimeout(() => ouvrir("minuterie"), 500);
  setInterval(() => ouvrir("boucle"), 300);
</script>`,
  });
  // Prend le focus puis demande un lien.
  ecrireWidget(racine, "focus", {
    nom: "Focus",
    affichage: `<!doctype html><p id="pret">prêt</p><script>
  const ouvrir = () => { document.body.tabIndex = 0; document.body.focus(); window.focus(); parent.postMessage({ type: "ouvrir", url: "https://exemple.invalid/focus" }, "*"); };
  ouvrir();
  setInterval(ouvrir, 400);
</script>`,
  });
  ecrireDisposition(racine, [
    { id: "liens", x: 0, y: 0, l: 4, h: 3 },
    { id: "sans-clic", x: 4, y: 0, l: 4, h: 3 },
    { id: "focus", x: 8, y: 0, l: 4, h: 3 },
  ]);
}

const liensOuverts = (app: ElectronApplication) =>
  app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()).filter((u) => u.includes("exemple.invalid")));

test("un widget n'ouvre aucun lien sans vrai clic (chargement, minuterie, boucle, focus forcé) ; javascript: est ignoré", async () => {
  const racine = nouvelleRacine();
  widgetsLiens(racine);
  const { app, fenetre, fermer } = await lancerWidgets(racine);
  // Ce que le process principal écarte : la preuve que les demandes lui sont bien parvenues.
  let journal = "";
  app.process().stderr?.on("data", (d) => (journal += String(d)));
  await expect(cadre(fenetre, "liens").locator("#lien")).toBeVisible();
  await expect(cadre(fenetre, "sans-clic").locator("#pret")).toBeVisible();
  await expect(cadre(fenetre, "focus").locator("#pret")).toBeVisible();
  await attendre(2000);
  for (const u of ["minuterie", "boucle", "focus"]) expect(journal).toContain(`ignoré (pas de clic dans le widget) : https://exemple.invalid/${u}`);
  // Un vrai clic sur un lien javascript: : rien.
  await cliquer(fenetre, cadre(fenetre, "liens").locator("#js"));
  await expect.poll(() => journal).toContain("javascript:alert(1)");
  await attendre(1500);
  await expect(fenetre.locator(onglets)).toHaveCount(0);
  expect(await liensOuverts(app)).toEqual([]);
  await fermer();
});

// CONSTAT (tâche 12) : un vrai clic dans l'affichage d'un widget n'est jamais vu par le process principal. L'iframe du
// widget (sandbox, origine opaque) tourne dans son propre processus (OOPIF) : le clic est routé vers ce cadre et
// l'événement `input-event` de la fenêtre ne se déclenche pas (vérifié : un clic Playwright, routé comme un vrai clic,
// clique bien le bouton du widget sans aucun `input-event` ; `sendInputEvent` déclenche `input-event` mais n'atteint pas
// le cadre). `gardienGestes` refuse donc toute demande : aucun lien de widget ne s'ouvre. Correction à décider (voir le
// rapport de la tâche 12). Ce test passera quand ce sera corrigé : retirer alors `test.fail`.
test("un lien cliqué dans un widget ouvre un onglet, un second clic un second onglet", async () => {
  test.fail();
  const racine = nouvelleRacine();
  widgetsLiens(racine);
  const { app, fenetre, fermer } = await lancerWidgets(racine);
  await expect(cadre(fenetre, "liens").locator("#lien")).toBeVisible();
  await cliquer(fenetre, cadre(fenetre, "liens").locator("#lien"));
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  // Retour à la page d'accueil, puis un second clic : un second lien.
  await fenetre.getByTestId("nouvel-onglet").click();
  await expect(cadre(fenetre, "liens").locator("#lien")).toBeVisible();
  await attendre(1100); // un lien par seconde au plus
  await cliquer(fenetre, cadre(fenetre, "liens").locator("#lien"));
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await attendre(2000);
  // Ni les demandes sans clic des autres widgets, ni un second lien par clic.
  expect((await liensOuverts(app)).sort()).toEqual(["https://exemple.invalid/lien-1", "https://exemple.invalid/lien-2"]);
  await fermer();
});

test("glisser un widget et l'agrandir réécrit disposition.json", async () => {
  const racine = nouvelleRacine();
  ecrireWidget(racine, "un", { nom: "Un", affichage: AFFICHAGE, exemple: 1 });
  ecrireWidget(racine, "deux", { nom: "Deux", affichage: AFFICHAGE, exemple: 2 });
  ecrireDisposition(racine, [
    { id: "un", x: 0, y: 0, l: 3, h: 2 },
    { id: "deux", x: 0, y: 2, l: 3, h: 2 },
  ]);
  const { fenetre, fermer } = await lancerWidgets(racine);
  await expect(donnees(fenetre, "un")).toHaveText("1");
  const grille = (await fenetre.getByTestId("accueil").boundingBox())!;
  const pas = (grille.width - 11 * 12) / 12 + 12;

  const glisserDe = async (cible: import("@playwright/test").Locator, dx: number, dy: number) => {
    const b = (await cible.boundingBox())!;
    const x = b.x + Math.min(20, b.width / 2);
    const y = b.y + b.height / 2;
    await fenetre.mouse.move(x, y);
    await fenetre.mouse.down();
    await fenetre.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
    await fenetre.mouse.move(x + dx, y + dy, { steps: 5 });
    await fenetre.mouse.up();
  };
  // Déplacer « un » de 4 colonnes à droite, par son en-tête.
  await glisserDe(fenetre.getByTestId("widget-un").getByTestId("titre-widget"), 4 * pas, 0);
  await expect.poll(() => lireDisposition(racine).find((p) => p.id === "un")).toEqual({ id: "un", x: 4, y: 0, l: 3, h: 2 });
  // L'agrandir de 2 colonnes et d'une rangée, par sa poignée.
  await glisserDe(fenetre.getByTestId("widget-un").getByTestId("poignee-taille"), 2 * pas, 102);
  await expect.poll(() => lireDisposition(racine).find((p) => p.id === "un")).toEqual({ id: "un", x: 4, y: 0, l: 5, h: 3 });
  expect(lireDisposition(racine).find((p) => p.id === "deux")).toEqual({ id: "deux", x: 0, y: 2, l: 3, h: 2 });
  // L'affichage suit la nouvelle place.
  const un = (await fenetre.getByTestId("widget-un").boundingBox())!;
  expect(Math.abs(un.x - (grille.x + 4 * pas))).toBeLessThan(2);
  expect(Math.abs(un.width - (5 * pas - 12))).toBeLessThan(2);
  await fermer();
});

/** Widget qui lit /lire-cookie avec le compte de l'utilisateur, et affiche ce que la page a vu. */
function widgetCompte(racine: string, id = "compte"): void {
  ecrireWidget(racine, id, {
    nom: "Compte",
    recolte: { minutes: 60 },
    sources: { compte: ["127.0.0.1"], publiques: [] },
    config: { url: `${site.url}/lire-cookie?compte` },
    code: `export default async (webaios) => ({ vu: (await webaios.lirePage(webaios.config.url, { compte: true })).titre });`,
    affichage: AFFICHAGE,
    exemple: { exemple: "compte" },
  });
}

/** Pose le cookie du serveur de test dans le profil de l'espace actif, par un onglet, puis revient à la page d'accueil. */
async function poserCookie(fenetre: Page): Promise<void> {
  await ouvrirOnglet(fenetre, `${site.url}/cookie`, { activer: true });
  await expect(fenetre.locator(onglets)).toContainText(["cookie"]);
  await fenetre.getByTestId("nouvel-onglet").click();
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
}

test("un widget avec compte affiche le bandeau d'accord ; Autoriser avec le profil par défaut lance la récolte, qui voit le cookie du profil", async () => {
  const racine = nouvelleRacine();
  widgetCompte(racine);
  const profil = nouveauProfil();
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  // Sans accord : rien n'est lu, le bandeau le demande, l'exemple reste affiché.
  await expect(fenetre.getByTestId("bandeau-accord")).toContainText("127.0.0.1");
  await expect(donnees(fenetre, "compte")).toHaveText('{"exemple":"compte"}');
  expect(site.journal.filter((r) => r.chemin === "/lire-cookie?compte")).toEqual([]);
  await poserCookie(fenetre);
  await fenetre.getByTestId("bandeau-accord").getByRole("button", { name: "Autoriser…" }).click();
  const carte = fenetre.getByTestId("carte-accord");
  await expect(carte).toContainText("127.0.0.1");
  // Le profil de l'espace actif (le profil par défaut) est coché.
  await expect(carte.getByRole("radio", { checked: true })).toHaveValue("defaut");
  await carte.getByRole("button", { name: "Autoriser" }).click();
  await expect(donnees(fenetre, "compte")).toHaveText('{"vu":"essai=1"}', { timeout: 20_000 });
  await expect(fenetre.getByTestId("bandeau-accord")).toBeHidden();
  expect(accords(profil).compte).toEqual({ domaines: ["127.0.0.1"], publiques: [], profil: "defaut" });
  expect(site.journal.filter((r) => r.chemin === "/lire-cookie?compte").map((r) => r.cookie)).toContain("essai=1");
  await fermer();
});

test("la lecture publique ne voit aucun cookie du profil", async () => {
  const racine = nouvelleRacine();
  ecrireWidget(racine, "public", {
    nom: "Public",
    recolte: { minutes: 60 },
    config: { url: `${site.url}/lire-cookie?public` },
    code: `export default async (webaios) => ({ vu: (await webaios.lirePage(webaios.config.url)).titre });`,
    affichage: AFFICHAGE,
    exemple: { exemple: "public" },
  });
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "public");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(donnees(fenetre, "public")).toHaveText('{"exemple":"public"}');
  await poserCookie(fenetre);
  // Témoin : le profil a bien le cookie (un onglet le montre).
  await ouvrirOnglet(fenetre, `${site.url}/lire-cookie?onglet`, { activer: true });
  await expect(fenetre.locator(onglets)).toContainText(["cookie", "essai=1"]);
  await fenetre.getByTestId("nouvel-onglet").click();
  await recolter(fenetre, "public");
  await expect(donnees(fenetre, "public")).toHaveText('{"vu":"aucun"}', { timeout: 20_000 });
  const lues = site.journal.filter((r) => r.chemin === "/lire-cookie?public");
  expect(lues.length).toBeGreaterThan(0);
  expect(lues.map((r) => r.cookie)).toEqual(lues.map(() => undefined));
  await fermer();
});

test("un profil qui devient privé fait repasser le widget en accord-requis", async () => {
  const racine = nouvelleRacine();
  widgetCompte(racine);
  const profil = nouveauProfil();
  mkdirSync(dossierWidgets(profil), { recursive: true });
  writeFileSync(
    join(dossierWidgets(profil), "accords.json"),
    JSON.stringify({ compte: { domaines: ["127.0.0.1"], publiques: [], profil: "defaut" } }),
  );
  // Sans état : récolté au lancement, avec l'accord.
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(donnees(fenetre, "compte")).toHaveText('{"vu":"aucun"}', { timeout: 20_000 });
  await expect(fenetre.getByTestId("bandeau-accord")).toBeHidden();
  await reglerEspaceActifPrive(fenetre, true);
  await recolter(fenetre, "compte");
  // L'accord et les données lues avec ce profil partent : le bandeau revient, l'exemple aussi.
  await expect(fenetre.getByTestId("bandeau-accord")).toBeVisible({ timeout: 20_000 });
  await expect(donnees(fenetre, "compte")).toHaveText('{"exemple":"compte"}');
  expect(accords(profil)).toEqual({});
  expect(existsSync(join(dossierWidgets(profil), "compte", "donnees.json"))).toBe(false);
  expect(lireJson(join(dossierWidgets(profil), "compte", "etat.json")).statut).toBe("accord-requis");
  // Le profil de l'espace privé n'est plus proposé.
  await fenetre.getByTestId("bandeau-accord").getByRole("button", { name: "Autoriser…" }).click();
  await expect(fenetre.getByTestId("carte-accord")).toContainText("Aucun profil utilisable.");
  await fermer();
});

test("une lecture avec compte ne quitte pas ses domaines (302, script, meta refresh), survit à print() et alert(), sans fenêtre visible", async () => {
  test.setTimeout(120_000);
  const racine = nouvelleRacine();
  const a = site.url;
  const b = `http://localhost:${autre.port}`;
  ecrireWidget(racine, "lectures", {
    nom: "Lectures",
    recolte: { minutes: 60 },
    sources: { compte: ["127.0.0.1"], publiques: ["localhost"] },
    config: { a, b },
    code: `export default async (webaios) => {
  const { a, b } = webaios.config;
  const r = {};
  const essayer = async (nom, url, compte) => {
    const t = Date.now();
    try {
      r[nom] = { titre: (await webaios.lirePage(url, { compte })).titre, ms: Date.now() - t };
    } catch (e) {
      r[nom] = { erreur: String(e?.message ?? e), ms: Date.now() - t };
    }
  };
  await essayer("temoin", b + "/temoin", false);
  await essayer("r302", a + "/r302", true);
  await essayer("js", a + "/js", true);
  await essayer("meta", a + "/meta", true);
  await essayer("imprime", a + "/imprime", true);
  await essayer("alerte", a + "/alerte", true);
  return r;
};`,
    affichage: AFFICHAGE,
  });
  const profil = nouveauProfil();
  mkdirSync(dossierWidgets(profil), { recursive: true });
  writeFileSync(
    join(dossierWidgets(profil), "accords.json"),
    JSON.stringify({ lectures: { domaines: ["127.0.0.1"], publiques: ["localhost"], profil: "defaut" } }),
  );
  const debutAutre = autre.journal.length;
  const { app, fenetre, fermer } = await lancerWidgets(racine, profil);
  // Pendant les lectures : la fenêtre cachée existe, jamais visible ni focalisable.
  const fenetresVues: { visible: boolean; focusable: boolean; principale: boolean }[][] = [];
  const fichier = join(dossierWidgets(profil), "lectures", "donnees.json");
  for (const fin = Date.now() + 90_000; Date.now() < fin && !existsSync(fichier); ) {
    fenetresVues.push(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((f) => ({
          visible: f.isVisible(),
          focusable: f.isFocusable(),
          principale: f.webContents.getURL().includes("/renderer/index.html"),
        })),
      ),
    );
    await attendre(100);
  }
  const r = lireJson(fichier);
  expect(r.temoin).toEqual({ titre: "Autre", ms: expect.any(Number) }); // « localhost » mène bien au second serveur
  for (const nom of ["r302", "js", "meta"]) expect(r[nom].erreur, nom).toBeTruthy();
  expect(r.imprime.titre).toBe("imprimé");
  expect(r.imprime.ms).toBeLessThan(15_000);
  expect(r.alerte.titre).toBe("alerté");
  expect(r.alerte.ms).toBeLessThan(15_000);
  // Le second hôte n'a reçu que la lecture témoin.
  expect(autre.journal.slice(debutAutre).map((x) => x.chemin)).toEqual(["/temoin"]);
  const cachees = fenetresVues.flat().filter((f) => !f.principale);
  expect(cachees.length).toBeGreaterThan(0);
  expect(cachees.filter((f) => f.visible || f.focusable)).toEqual([]);
  await expect(donnees(fenetre, "lectures")).toContainText("imprimé");
  await fermer();
});

test("l'affichage d'un widget ne peut joindre aucun serveur", async () => {
  const udp = createSocket("udp4");
  const paquets: Buffer[] = [];
  udp.on("message", (m) => paquets.push(m));
  await new Promise<void>((ok) => udp.bind(0, "127.0.0.1", ok));
  const portUdp = udp.address().port;
  const racine = nouvelleRacine();
  const a = site.url;
  ecrireWidget(racine, "espion", {
    nom: "Espion",
    affichage: `<!doctype html><meta charset="utf-8"><p id="rtc">…</p>
<script>
  fetch(${JSON.stringify(`${a}/espion-fetch`)}).catch(() => {});
  try { navigator.sendBeacon(${JSON.stringify(`${a}/espion-balise`)}, "x"); } catch {}
  try { new WebSocket(${JSON.stringify(`ws://127.0.0.1:${site.port}/espion-ws`)}); } catch {}
  const i = new Image(); i.src = ${JSON.stringify(`${a}/espion-image`)}; document.body.append(i);
  document.body.insertAdjacentHTML("beforeend", '<img src="${a}/espion-img"><link rel="prefetch" href="${a}/espion-prefetch">');
  (async () => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${portUdp}" }] });
      pc.createDataChannel("x");
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") document.getElementById("rtc").textContent = "fini"; };
      await pc.setLocalDescription(await pc.createOffer());
      document.getElementById("rtc").textContent = "offre";
    } catch (e) { document.getElementById("rtc").textContent = "erreur " + e; }
  })();
</script>`,
  });
  widgetsFuite(racine, a);
  try {
    const { fenetre, fermer } = await lancerWidgets(racine);
    await expect(cadre(fenetre, "espion").locator("#rtc")).not.toHaveText("…");
    // Le premier chargement de l'affichage passe ; la navigation qui suit ne sort pas.
    await expect(donnees(fenetre, "fuite")).toHaveText('"reste"');
    await expect(donnees(fenetre, "fuite-data")).toHaveText('"reste"');
    await attendre(3000);
    expect(fenetre.frames().map((f) => f.url()).filter((u) => u.includes("fuite-navigation") || u.startsWith("data:"))).toEqual([]);
    expect(site.journal.filter((r) => /espion|fuite/.test(r.chemin))).toEqual([]);
    expect(paquets.length, `STUN reçu : ${paquets.length} paquet(s) UDP ; état WebRTC du widget : ${await cadre(fenetre, "espion").locator("#rtc").textContent()}`).toBe(0);
    await fermer();
  } finally {
    udp.close();
  }
});

/** Deux widgets qui, après leur premier affichage, naviguent ailleurs : vers le serveur de test, vers une URL data:. */
function widgetsFuite(racine: string, a: string): void {
  ecrireWidget(racine, "fuite", {
    nom: "Fuite",
    affichage: AFFICHAGE.replace("</script>", `setTimeout(() => (location = ${JSON.stringify(`${a}/fuite-navigation?d=secret`)}), 1500);</script>`),
    exemple: "reste",
  });
  ecrireWidget(racine, "fuite-data", {
    nom: "Fuite data",
    affichage: AFFICHAGE.replace("</script>", `setTimeout(() => (location = "data:text/html,<pre id=donnees>pirate</pre>"), 1500);</script>`),
    exemple: "reste",
  });
}

// CONSTAT (tâche 12) : la navigation d'un affichage hors de `webaios-widget:` est bloquée par la CSP de l'interface
// (ERR_BLOCKED_BY_CSP, avant tout envoi : le serveur ne reçoit rien, voir le test précédent), mais le cadre affiche
// alors la page d'erreur de Chromium au lieu de rester sur son affichage. Sans fuite : le widget ne casse que lui-même.
// Retirer `test.fail` si l'interface recharge un jour l'affichage dans ce cas.
test("un widget qui navigue ailleurs reste sur son affichage", async () => {
  test.fail();
  const racine = nouvelleRacine();
  widgetsFuite(racine, site.url);
  const { fenetre, fermer } = await lancerWidgets(racine);
  await expect(donnees(fenetre, "fuite")).toHaveText('"reste"');
  await attendre(3000);
  await expect(donnees(fenetre, "fuite")).toHaveText('"reste"', { timeout: 1000 });
  await expect(donnees(fenetre, "fuite-data")).toHaveText('"reste"', { timeout: 1000 });
  await fermer();
});

test("IA locale sans Kev installé : l'indicateur affiche « non installée » et rien n'est téléchargé sans clic", async () => {
  // Faux git, uv et ollama en tête du PATH : chaque appel est noté (rien ne doit cloner, synchroniser ni tirer).
  const outils = realpathSync(mkdtempSync(join(tmpdir(), "webaios-outils-ia-")));
  const journal = join(outils, "appels.log");
  for (const nom of ["git", "uv", "ollama"]) {
    const f = join(outils, nom);
    writeFileSync(f, `#!/bin/sh\necho "${nom} $*" >> "${journal}"\n[ "$1" = "--version" ] && echo "${nom} 0.0.0"\nexit 0\n`);
    chmodSync(f, 0o755);
  }
  const profil = nouveauProfil();
  const debutOllama = ollama.journal.length;
  const { fenetre, fermer } = await lancer({
    profil,
    env: {
      WEBAIOS_OLLAMA_URL: ollama.url,
      PATH: `${outils}:${join(__dirname, "outils")}:${process.env.PATH ?? ""}`,
    },
  });
  const ia = fenetre.getByTestId("ia-locale");
  await expect(ia).toContainText("non installée");
  await expect(fenetre.getByTestId("installer-ia")).toBeVisible();
  // Ouvrir la confirmation puis annuler : toujours rien.
  await fenetre.getByTestId("installer-ia").click();
  await expect(fenetre.getByTestId("confirmation-installer-ia")).toContainText("Télécharger");
  await fenetre.getByTestId("confirmation-installer-ia").getByRole("button", { name: "Annuler" }).click();
  await expect(fenetre.getByTestId("confirmation-installer-ia")).toBeHidden();
  await attendre(2000);
  await expect(ia).toContainText("non installée");
  const appels = existsSync(journal) ? readFileSync(journal, "utf8").trim().split("\n") : [];
  expect(appels.filter((l) => /^git clone|^uv sync|^ollama pull|^uv run/.test(l))).toEqual([]);
  expect(ollama.journal.slice(debutOllama).filter((r) => !r.chemin.startsWith("/api/tags"))).toEqual([]);
  expect(existsSync(join(profil, "ia-locale", "kev"))).toBe(false);
  await fermer();
});

// ---------------------------------------------------------------------------------------------------------------------
// Page d'accueil et panneau agent (sans récolte)

test("l'agent écrit un nouveau widget : il apparaît sans recharger", async () => {
  const { fenetre, racine, fermer } = await lancer({ env: envWidgets() });
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await attendre(1000); // surveillance du dossier en place
  ecrireWidget(racine, "nouveau", { nom: "Nouveau", affichage: AFFICHAGE, exemple: "tout neuf" });
  await expect(fenetre.locator('[data-testid="titre-widget"]')).toHaveText(["Nouveau"], { timeout: 5000 });
  await expect(donnees(fenetre, "nouveau")).toHaveText('"tout neuf"');
  await fermer();
});

test("Retirer : le widget part à la corbeille ; Annuler le garde", async () => {
  const racine = nouvelleRacine();
  for (const [id, nom] of [["un", "Un"], ["deux", "Deux"]] as const) ecrireWidget(racine, id, { nom, affichage: AFFICHAGE, exemple: nom });
  ecrireDisposition(racine, [
    { id: "un", x: 0, y: 0, l: 3, h: 2 },
    { id: "deux", x: 3, y: 0, l: 3, h: 2 },
  ]);
  const { fenetre, fermer } = await lancerWidgets(racine);
  const deux = fenetre.getByTestId("widget-deux");
  const retirer = async () => {
    await deux.getByRole("button", { name: "Options du widget" }).click();
    await deux.getByRole("menuitem", { name: "Retirer" }).click();
  };
  const confirmation = fenetre.getByTestId("confirmation-retrait");
  await retirer();
  await expect(confirmation).toContainText("Retirer « Deux » de la page d'accueil ?");
  await confirmation.getByRole("button", { name: "Annuler" }).click();
  await expect(confirmation).toBeHidden();
  await expect(fenetre.locator('[data-testid="titre-widget"]')).toHaveText(["Un", "Deux"]);
  await retirer();
  await confirmation.getByRole("button", { name: "Retirer" }).click();
  await expect(fenetre.locator('[data-testid="titre-widget"]')).toHaveText(["Un"]);
  await expect.poll(() => existsSync(join(racine, "accueil", "widgets", "deux"))).toBe(false);
  expect(readdirSync(join(racine, "accueil", ".corbeille")).some((f) => f.startsWith("deux-"))).toBe(true);
  await expect.poll(() => lireDisposition(racine).map((p) => p.id)).toEqual(["un"]);
  await fermer();
});

test("fermer le panneau sur la page d'accueil le laisse fermé", async () => {
  const { fenetre, fermer } = await lancer();
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await fenetre.getByTestId("bouton-agent").click();
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await attendre(500);
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await fermer();
});

test("quitter la page d'accueil referme le panneau qui ne s'était ouvert que pour elle, y revenir le rouvre", async () => {
  const { fenetre, fermer } = await lancer();
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await ouvrirOnglet(fenetre, `${site.url}/a`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await fenetre.getByTestId("nouvel-onglet").click();
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await fermer();
});

test("le panneau ouvert par la page d'accueil laisse la saisie d'adresse active ; ⌘J y met le terminal", async () => {
  const { app, fenetre, fermer } = await lancer();
  await expect(fenetre.getByTestId("panneau-agent").locator(".xterm-rows")).toContainText("faux agent prêt>");
  const actif = () => fenetre.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? document.activeElement?.className);
  expect(await actif()).toBe("saisie-page-vide");
  const menuAgent = (a: ElectronApplication) => a.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("panneau-agent")?.click());
  await menuAgent(app);
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await menuAgent(app);
  await expect.poll(actif).toContain("xterm-helper-textarea");
  await fermer();
});

test("une webview injectée avec file:// ou un preload n'est pas attachée", async () => {
  const { app, fenetre, fermer } = await lancer();
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await fenetre.evaluate(() => {
    const w = document.createElement("webview");
    w.setAttribute("src", "file:///etc/hosts");
    document.body.append(w);
    const p = document.createElement("webview");
    p.setAttribute("src", "about:blank");
    p.setAttribute("preload", "file:///tmp/x.js");
    document.body.append(p);
  });
  await attendre(2000);
  const types = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getType()));
  expect(types.filter((t) => t === "webview")).toEqual([]);
  await fermer();
});

test("sans dossier accueil lisible, la page vide reste utilisable", async () => {
  const racine = nouvelleRacine();
  chmodSync(join(racine, "accueil"), 0o000);
  try {
    const { fenetre, fermer } = await lancer({ racine });
    await fenetre.getByTestId("saisie-page-vide").fill(`${site.url}/a`);
    await fenetre.getByTestId("saisie-page-vide").press("Enter");
    await expect(fenetre.locator(onglets)).toHaveCount(1);
    await fermer();
  } finally {
    chmodSync(join(racine, "accueil"), 0o755);
  }
});

test("l'agent ne démarre pas : la page d'accueil affiche quand même ses widgets, et les nouveaux", async () => {
  const racine = nouvelleRacine();
  mkdirSync(join(racine, ".webaios", "profils"), { recursive: true });
  writeFileSync(join(racine, ".webaios", "profils", "claude.json"), "{ illisible");
  ecrireWidget(racine, "veille", { nom: "Veille", affichage: AFFICHAGE, exemple: "article" });
  ecrireDisposition(racine, [{ id: "veille", x: 0, y: 0, l: 4, h: 2 }]);
  const { fenetre, fermer } = await lancer({ racine });
  await expect(fenetre.getByTestId("panneau-agent")).toContainText("L'agent n'a pas pu démarrer", { timeout: 10_000 });
  await expect(fenetre.locator('[data-testid="titre-widget"]')).toHaveText(["Veille"]);
  await expect(donnees(fenetre, "veille")).toHaveText('"article"');
  ecrireWidget(racine, "autre", { nom: "Autre", affichage: AFFICHAGE, exemple: "nouveau" });
  await expect(fenetre.locator('[data-testid="titre-widget"]')).toHaveText(["Veille", "Autre"], { timeout: 5000 });
  await fermer();
});

test("tirer le bord gauche du panneau agent change sa largeur, retenue au prochain lancement", async () => {
  const premier = await lancer();
  const panneau = () => premier.fenetre.getByTestId("panneau-agent");
  await expect(panneau()).toBeVisible();
  expect((await panneau().boundingBox())!.width).toBe(420);
  const p = (await premier.fenetre.getByTestId("poignee-agent").boundingBox())!;
  const x = p.x + p.width / 2;
  const y = p.y + p.height / 2;
  await premier.fenetre.mouse.move(x, y);
  await premier.fenetre.mouse.down();
  await premier.fenetre.mouse.move(x - 100, y, { steps: 5 });
  await premier.fenetre.mouse.move(x - 200, y, { steps: 5 });
  await premier.fenetre.mouse.up();
  await expect.poll(async () => Math.round((await panneau().boundingBox())!.width)).toBe(620);
  await premier.fermer();
  const second = await lancer({ profil: premier.profil, racine: premier.racine });
  await expect(second.fenetre.getByTestId("panneau-agent")).toBeVisible();
  await expect.poll(async () => Math.round((await second.fenetre.getByTestId("panneau-agent").boundingBox())!.width)).toBe(620);
  await second.fermer();
});
