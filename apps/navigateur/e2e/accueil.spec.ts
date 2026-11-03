import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { createSocket } from "node:dgram";
import { createServer as createNetServer, type AddressInfo } from "node:net";
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
  dansLaVue,
  ouvrirOnglet,
  reglerEspaceActifPrive,
} from "./aide";
import { prochaineExecution } from "../src/renderer/composants/prochaine";

const onglets = '[data-testid^="onglet-"]';
/** Image PNG de 1 × 1 pixel. */
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
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
      case "/sonde":
        return html(res, "<title>?</title><script>document.title = [typeof window.webaios, typeof require, typeof process].join(' ')</script>");
      case "/indice-dns": {
        // Page d'onglet avec un indice de résolution vers l'hôte demandé (sans aucune garde : seul le réglage de Chromium joue).
        const h = new URL(req.url ?? "/", "http://x").searchParams.get("h") ?? "";
        return html(res, `<title>indice</title><link rel="dns-prefetch" href="//${h}"><link rel="preconnect" href="https://pre-${h}/">`);
      }
      case "/avec-icone":
        return html(res, '<title>Icône</title><link rel="icon" href="/icone.png"><p>ok</p>');
      case "/icone.png":
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(PNG_1PX);
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
  // Le preload tourne dans le cadre du widget, mais son code n'en voit rien.
  ecrireWidget(racine, "sonde", {
    nom: "Sonde",
    affichage: `<!doctype html><p id="sonde"></p><script>
  document.getElementById("sonde").textContent = [typeof window.webaios, typeof window.api, typeof require, typeof process, typeof module, typeof window.ipcRenderer].join(" ");
</script>`,
  });
  ecrireDisposition(racine, [
    { id: "un", x: 0, y: 0, l: 3, h: 2 },
    { id: "deux", x: 6, y: 1, l: 4, h: 3 },
    { id: "meteo", x: 0, y: 4, l: 3, h: 2 },
    { id: "sans-affichage", x: 4, y: 4, l: 2, h: 2 },
    { id: "sonde", x: 6, y: 4, l: 2, h: 2 },
  ]);
  const profil = nouveauProfil();
  // Une récolte déjà en échec (données absentes) : l'exemple reste affiché, le badge dit l'échec.
  ecrireEtatWidget(profil, "deux", { statut: "erreur", derniereMaj: null, derniereTentative: new Date().toISOString(), erreur: "Délai dépassé", erreurNoyau: true });
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(fenetre.getByTestId("accueil")).toBeVisible();
  await expect(fenetre.locator('[data-testid="titre-widget"]')).toHaveText(["Un", "Deux", "Météo", "Sans affichage", "Sonde"]);
  await expect(donnees(fenetre, "un")).toHaveText('{"exemple":"un"}');
  await expect(donnees(fenetre, "deux")).toHaveText('{"exemple":"deux"}');
  await expect(fenetre.getByTestId("widget-deux")).toContainText("Délai dépassé");
  await expect(cadre(fenetre, "meteo").locator("#ville")).toHaveText("Bordeaux");
  await expect(fenetre.getByTestId("widget-sans-affichage")).toContainText("pas encore écrit l'affichage");
  await expect(cadre(fenetre, "sonde").locator("#sonde")).toHaveText("undefined undefined undefined undefined undefined undefined");

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
  // Une URL par clic (la page d'accueil recrée le cadre quand on y revient).
  document.getElementById("lien").onclick = () => parent.postMessage({ type: "ouvrir", url: "https://exemple.invalid/lien-" + Date.now() }, "*");
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

/** URL des onglets ouverts vers exemple.invalid, lues dans l'état du navigateur (une vue n'existe que pour l'onglet actif). */
const liensOuverts = (fenetre: Page) =>
  fenetre.evaluate(
    () =>
      new Promise<string[]>((ok) => {
        type Etat = { onglets: Record<string, { url: string }> };
        const w = window as unknown as Window & { webaios: { surEtat(r: (e: Etat) => void): () => void } };
        const fin = w.webaios.surEtat((e) => {
          setTimeout(() => fin());
          ok(Object.values(e.onglets).map((o) => o.url).filter((u) => u.includes("exemple.invalid")));
        });
      }),
  );

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
  // Un vrai clic sur un lien javascript: : le clic est vu, l'URL refusée.
  await cliquer(fenetre, cadre(fenetre, "liens").locator("#js"));
  await expect.poll(() => journal).toContain("lien de widget refusé : javascript:alert(1)");
  await attendre(1500);
  await expect(fenetre.locator(onglets)).toHaveCount(0);
  expect(await liensOuverts(fenetre)).toEqual([]);
  await fermer();
});

// Le clic est vu dans le cadre du widget (hors process) par le preload, en monde isolé : un clic Playwright passe par le
// même routage qu'un vrai clic de la souris.
test("un lien cliqué dans un widget ouvre un onglet, un second clic un second onglet", async () => {
  const racine = nouvelleRacine();
  widgetsLiens(racine);
  const { fenetre, fermer } = await lancerWidgets(racine);
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
  const liens = await liensOuverts(fenetre);
  expect(liens).toHaveLength(2);
  expect(new Set(liens).size).toBe(2);
  for (const l of liens) expect(l).toMatch(/^https:\/\/exemple\.invalid\/lien-\d+$/);
  await fermer();
});

test("un widget qui vole le focus le rend : la frappe de l'utilisateur reste dans le champ de l'accueil, aucun lien", async () => {
  const racine = nouvelleRacine();
  // Un bouton qui reprend le focus sans cesse : une touche tapée ailleurs l'active (clic « isTrusted », sans appui).
  ecrireWidget(racine, "voleur", {
    nom: "Voleur",
    affichage: `<!doctype html><button id="b" style="width:200px;height:50px">b</button><script>
  const b = document.getElementById("b");
  let n = 0;
  b.onclick = () => parent.postMessage({ type: "ouvrir", url: "https://exemple.invalid/vol-" + ++n }, "*");
  setInterval(() => b.focus(), 50);
</script>`,
  });
  const { app, fenetre, fermer } = await lancerWidgets(racine);
  let journal = "";
  app.process().stderr?.on("data", (d) => (journal += String(d)));
  await expect(cadre(fenetre, "voleur").locator("#b")).toBeVisible();
  await attendre(500);
  await fenetre.keyboard.press("Space");
  await fenetre.keyboard.type("abc");
  await expect(fenetre.getByTestId("saisie-page-vide")).toHaveValue(" abc");
  await attendre(1000);
  expect(journal).not.toContain("https://exemple.invalid/vol-");
  await expect(fenetre.locator(onglets)).toHaveCount(0);
  await fermer();
});

test("un clic ouvre un seul lien même si le widget en demande deux", async () => {
  const racine = nouvelleRacine();
  ecrireWidget(racine, "double", {
    nom: "Double",
    affichage: `<!doctype html><button id="b" style="width:200px;height:50px">b</button><script>
  document.getElementById("b").onclick = () => {
    parent.postMessage({ type: "ouvrir", url: "https://exemple.invalid/double-1" }, "*");
    parent.postMessage({ type: "ouvrir", url: "https://exemple.invalid/double-2" }, "*");
  };
</script>`,
  });
  const { fenetre, fermer } = await lancerWidgets(racine);
  await cliquer(fenetre, cadre(fenetre, "double").locator("#b"));
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await attendre(2000);
  expect(await liensOuverts(fenetre)).toEqual(["https://exemple.invalid/double-1"]);
  await fermer();
});

test("les cadres imbriqués d'un widget (srcdoc, about:blank) n'ont aucune API et leurs clics ne comptent pas", async () => {
  const racine = nouvelleRacine();
  const sonde = "[typeof window.webaios, typeof window.api, typeof require, typeof process].join()";
  ecrireWidget(racine, "imbrique", {
    nom: "Imbriqué",
    tailles: { min: { l: 2, h: 2 }, max: { l: 12, h: 8 }, defaut: { l: 8, h: 4 } },
    affichage: `<!doctype html><p id="srcdoc">?</p><p id="vide">?</p><script>onerror = (m) => (document.getElementById("vide").textContent = "erreur " + m);</script><script>
  addEventListener("message", (e) => {
    if (e.data && e.data.sonde) document.getElementById("srcdoc").textContent = e.data.sonde;
    if (e.data && e.data.ouvrir) parent.postMessage({ type: "ouvrir", url: "https://exemple.invalid/imbrique" }, "*");
  });
  const s = document.createElement("iframe");
  s.id = "s";
  s.style = "width:300px;height:120px";
  s.srcdoc = '<button id="b" style="width:200px;height:50px">b</button><script>parent.postMessage({ sonde: ${sonde} }, "*"); document.getElementById("b").onclick = () => parent.postMessage({ ouvrir: 1 }, "*");<\\/script>';
  document.body.append(s);
  const v = document.createElement("iframe");
  document.body.append(v);
  try {
    const w = v.contentWindow;
    document.getElementById("vide").textContent = [typeof w.webaios, typeof w.api, typeof w.require, typeof w.process].join();
  } catch (e) { document.getElementById("vide").textContent = "inaccessible " + e; }
</script>`,
  });
  const { app, fenetre, fermer } = await lancerWidgets(racine);
  let journal = "";
  app.process().stderr?.on("data", (d) => (journal += String(d)));
  const w = cadre(fenetre, "imbrique");
  // Le cadre about:blank n'est même pas joignable depuis le widget (origine opaque) ; s'il l'était, rien n'y serait exposé.
  await expect(w.locator("#vide")).toHaveText(/^(undefined,undefined,undefined,undefined|inaccessible SecurityError.*)$/);
  await expect(w.locator("#srcdoc")).toHaveText("undefined,undefined,undefined,undefined");
  // Un vrai clic dans le cadre srcdoc : le widget demande un lien, refusé (aucun geste n'est retenu de ce cadre).
  await cliquer(fenetre, w.frameLocator("#s").locator("#b"));
  await expect.poll(() => journal).toContain("ignoré (pas de clic dans le widget) : https://exemple.invalid/imbrique");
  await attendre(1000);
  await expect(fenetre.locator(onglets)).toHaveCount(0);
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

test("la carte d'accord montre aussi les sites publics ; si la déclaration change avant le clic, rien n'est accordé", async () => {
  const racine = nouvelleRacine();
  widgetCompte(racine);
  const profil = nouveauProfil();
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const bandeau = fenetre.getByTestId("bandeau-accord");
  await expect(bandeau).toContainText("Ce widget veut lire 127.0.0.1 avec ton compte, et ne contactera aucun autre site.");
  await bandeau.getByRole("button", { name: "Autoriser…" }).click();
  const carte = fenetre.getByTestId("carte-accord");
  await expect(carte.getByTestId("accord-compte")).toContainText("127.0.0.1");
  await expect(carte.getByTestId("accord-publiques")).toHaveText("Et ne contactera aucun autre site.");
  // L'agent réécrit la déclaration pendant que la carte est ouverte : un site public de plus.
  const fichier = join(racine, "accueil", "widgets", "compte", "widget.json");
  writeFileSync(fichier, JSON.stringify({ ...lireJson(fichier), sources: { compte: ["127.0.0.1"], publiques: ["espion.example"] } }));
  await carte.getByRole("button", { name: "Autoriser" }).click();
  await expect(fenetre.getByTestId("widget-compte")).toContainText("Accord non enregistré");
  expect(accords(profil)).toEqual({});
  // La nouvelle demande s'affiche, avec le site public ; l'accord porte alors sur elle.
  await expect(bandeau).toContainText("et pourra contacter : espion.example");
  await bandeau.getByRole("button", { name: "Autoriser…" }).click();
  await expect(carte.getByTestId("accord-publiques")).toHaveText("Et pourra contacter : espion.example.");
  await carte.getByRole("button", { name: "Autoriser" }).click();
  await expect.poll(() => accords(profil).compte).toEqual({ domaines: ["127.0.0.1"], publiques: ["espion.example"], profil: "defaut" });
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
  await essayer("sonde", a + "/sonde", true);
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
  // La fenêtre de lecture n'a pas de preload.
  expect(r.sonde.titre).toBe("undefined undefined undefined");
  // Le second hôte n'a reçu que la lecture témoin.
  expect(autre.journal.slice(debutAutre).map((x) => x.chemin)).toEqual(["/temoin"]);
  const cachees = fenetresVues.flat().filter((f) => !f.principale);
  expect(cachees.length).toBeGreaterThan(0);
  expect(cachees.filter((f) => f.visible || f.focusable)).toEqual([]);
  await expect(donnees(fenetre, "lectures")).toContainText("imprimé");
  await fermer();
});

/** Serveur TCP local qui compte les connexions (un serveur TURN en TCP n'a besoin de rien d'autre pour recevoir des données). */
async function compteurTcp(): Promise<{ port: number; connexions: () => number; fermer(): Promise<void> }> {
  let n = 0;
  const serveur = createNetServer((s) => {
    n++;
    s.on("error", () => {});
    s.destroy();
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  return { port: (serveur.address() as AddressInfo).port, connexions: () => n, fermer: () => new Promise((ok) => serveur.close(() => ok())) };
}

/** Code qui ouvre une connexion WebRTC vers un serveur TURN en TCP et un STUN en UDP ; écrit son résultat avec `noter`. */
const codeRtc = (tcp: number, udp: number, noter: string) => `try {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "turn:127.0.0.1:${tcp}?transport=tcp", username: "SECRET", credential: "x" }, { urls: "stun:127.0.0.1:${udp}" }] });
  pc.createDataChannel("x");
  pc.createOffer().then((o) => pc.setLocalDescription(o));
  ${noter}("lancé");
} catch (e) { ${noter}("erreur " + e.name); }`;

test("l'affichage d'un widget ne peut joindre aucun serveur (ni WebRTC TURN/TCP ou STUN/UDP, y compris depuis ses cadres imbriqués)", async () => {
  const udp = createSocket("udp4");
  const paquets: Buffer[] = [];
  udp.on("message", (m) => paquets.push(m));
  await new Promise<void>((ok) => udp.bind(0, "127.0.0.1", ok));
  const portUdp = udp.address().port;
  const tcp = await compteurTcp();
  const racine = nouvelleRacine();
  const a = site.url;
  const dansCadre = `<script>const noter = (t) => parent.postMessage({ imbrique: t }, "*"); ${codeRtc(tcp.port, portUdp, "noter")}</script>`;
  // Chaîne JS placée dans le script de l'affichage : « </ » y fermerait le script.
  const enChaine = (t: string) => JSON.stringify(t).replace(/<\//g, "<\\/");
  ecrireWidget(racine, "espion", {
    nom: "Espion",
    affichage: `<!doctype html><meta charset="utf-8"><p id="rtc">…</p><p id="imbrique">…</p><p id="js">…</p><p id="vide">…</p>
<script>
  const note = (id, t) => (document.getElementById(id).textContent = t);
  const essai = (f) => { try { f(); } catch {} };
  essai(() => fetch(${JSON.stringify(`${a}/espion-fetch`)}).catch(() => {}));
  essai(() => navigator.sendBeacon(${JSON.stringify(`${a}/espion-balise`)}, "x"));
  essai(() => new WebSocket(${JSON.stringify(`ws://127.0.0.1:${site.port}/espion-ws`)}));
  essai(() => { const i = new Image(); i.src = ${JSON.stringify(`${a}/espion-image`)}; document.body.append(i); });
  essai(() => document.body.insertAdjacentHTML("beforeend", '<img src="${a}/espion-img">'));
  // « <" + "link » : écrit en clair, le navigateur refuserait tout l'affichage (voir le test suivant).
  essai(() => document.body.insertAdjacentHTML("beforeend", "<" + 'link rel="prefetch" href="${a}/espion-prefetch">'));
  ${codeRtc(tcp.port, portUdp, "((t) => note('rtc', t))")}
  addEventListener("message", (e) => { if (e.data && e.data.imbrique) note("imbrique", e.data.imbrique); });
  // Cadre srcdoc : la garde du preload y est aussi.
  const s = document.createElement("iframe");
  s.srcdoc = ${enChaine(dansCadre)};
  document.body.append(s);
  // Cadre javascript: (sans preload) : refusé par Trusted Types.
  const j = document.createElement("iframe");
  try { j.setAttribute("src", "javascript:" + encodeURIComponent(${enChaine(dansCadre)})); note("js", "posé"); } catch (e) { note("js", "erreur " + e.name); }
  document.body.append(j);
  // Cadre about:blank (sans preload) : le widget ne peut pas y prendre un constructeur neuf.
  const v = document.createElement("iframe");
  document.body.append(v);
  try { note("vide", typeof v.contentWindow.RTCPeerConnection); } catch (e) { note("vide", "erreur " + e.name); }
</script>`,
  });
  widgetsFuite(racine, a);
  try {
    const { fenetre, fermer } = await lancerWidgets(racine);
    const w = cadre(fenetre, "espion");
    await expect(w.locator("#rtc")).toHaveText("erreur ReferenceError");
    await expect(w.locator("#imbrique")).toHaveText("erreur ReferenceError");
    await expect(w.locator("#vide")).toHaveText("erreur SecurityError");
    // Le premier chargement de l'affichage passe ; la navigation qui suit ne sort pas.
    await expect(donnees(fenetre, "fuite")).toHaveText('"reste"');
    await expect(donnees(fenetre, "fuite-data")).toHaveText('"reste"');
    await attendre(3000);
    expect(fenetre.frames().map((f) => f.url()).filter((u) => u.includes("fuite-navigation") || u.startsWith("data:"))).toEqual([]);
    expect(site.journal.filter((r) => /espion|fuite/.test(r.chemin))).toEqual([]);
    expect(tcp.connexions(), "connexions TCP reçues par le faux serveur TURN").toBe(0);
    expect(paquets.length, `STUN reçu : ${paquets.length} paquet(s) UDP`).toBe(0);
    await fermer();
  } finally {
    udp.close();
    await tcp.fermer();
  }
});

test("filet réseau : une page de la session de l'interface, sans la garde du preload, n'atteint aucun serveur par WebRTC", async () => {
  const tcp = await compteurTcp();
  const udp = createSocket("udp4");
  const paquets: Buffer[] = [];
  udp.on("message", (m) => paquets.push(m));
  await new Promise<void>((ok) => udp.bind(0, "127.0.0.1", ok));
  try {
    const { app, fermer } = await lancerWidgets(nouvelleRacine());
    const page = `<title>…</title><script>const noter = (t) => (document.title = t); ${codeRtc(tcp.port, udp.address().port, "noter")}</script>`;
    // Fenêtre cachée de la session par défaut, sans preload : WebRTC y existe, seul le filet réseau l'arrête.
    const titre = await app.evaluate(async ({ BrowserWindow }, html) => {
      const f = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
      f.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      await f.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await new Promise((ok) => setTimeout(ok, 4000));
      const t = f.webContents.getTitle();
      f.destroy();
      return t;
    }, page);
    expect(titre).toBe("lancé");
    expect(tcp.connexions(), "connexions TCP reçues par le faux serveur TURN").toBe(0);
    expect(paquets).toHaveLength(0);
    await fermer();
  } finally {
    udp.close();
    await tcp.fermer();
  }
});

test("l'affichage d'un widget ne fait résoudre aucun nom (dns-prefetch, preconnect, x-dns-prefetch-control, image), ni une page d'onglet par <link> ; une navigation, si", async () => {
  const suffixe = `w${Date.now().toString(36)}.webaios-test.example`;
  const journalReseau = join(realpathSync(mkdtempSync(join(tmpdir(), "webaios-netlog-"))), "netlog.json");
  const racine = nouvelleRacine();
  // Affichage qui en contient dès le HTML : servi refusé (le parseur passerait avant toute garde).
  ecrireWidget(racine, "dns-statique", {
    nom: "DNS statique",
    affichage: `<!doctype html><link rel="dns-prefetch" href="//statique.${suffixe}"><link rel="preconnect" href="https://preco.${suffixe}"><p id="ok">pas refusé</p>`,
  });
  ecrireWidget(racine, "dns-meta", {
    nom: "DNS meta",
    affichage: `<!doctype html><meta http-equiv="x-dns-prefetch-control" content="on"><a href="https://ancre.${suffixe}/">a</a><p id="ok">pas refusé</p>`,
  });
  // Contournements relevés à la revue (round 2) : srcdoc imbriqué avec « & » en référence numérique.
  ecrireWidget(racine, "dns-entites", {
    nom: "DNS entités",
    affichage: `<!doctype html><iframe srcdoc="<iframe srcdoc='&#38;lt;link rel=dns-prefetch href=//entite.${suffixe}>'></iframe>"></iframe><p id="ok">pas refusé</p>`,
  });
  ecrireWidget(racine, "dns-entites-hex", {
    nom: "DNS entités hex",
    affichage: `<!doctype html><iframe srcdoc="&#x26;lt;link rel=dns-prefetch href=//entite-hex.${suffixe}>"></iframe><p id="ok">pas refusé</p>`,
  });
  // Un widget de départ s'affiche toujours (createElement, append, replaceChildren passent la garde).
  ecrireWidget(racine, "actus-tech", {
    nom: "Actus",
    affichage: readFileSync(join(MODELES, "actus-tech", "affichage.html"), "utf8"),
    exemple: lireJson(join(MODELES, "actus-tech", "exemple.json")),
  });
  // Affichage qui en écrit par script : chaque tentative est refusée.
  ecrireWidget(racine, "dns-script", {
    nom: "DNS script",
    // « <" + "link » : écrit en clair, l'affichage entier serait refusé (comme dns-statique).
    affichage: `<!doctype html><meta charset="utf-8"><p id="r"></p><script>
  const L = "<" + "link";
  const r = [];
  const essai = (nom, f) => { try { f(); r.push(nom + ":passé"); } catch (e) { r.push(nom + ":" + e.name); } };
  essai("create", () => { const l = document.createElement("link"); l.rel = "dns-prefetch"; l.href = "//create.${suffixe}"; document.head.append(l); });
  essai("inner", () => { document.body.innerHTML += L + ' rel="dns-prefetch" href="//inner.${suffixe}">'; });
  essai("srcdoc", () => { const f = document.createElement("iframe"); f.srcdoc = L + ' rel=dns-prefetch href=//srcdoc.${suffixe}>'; document.body.append(f); });
  essai("meta", () => { const m = document.createElement("meta"); m.httpEquiv = "x-dns-prefetch-control"; m.content = "on"; document.head.append(m); });
  essai("image", () => { const i = new Image(); i.src = "https://image.${suffixe}/i.png"; document.body.append(i); });
  essai("ancre", () => { document.body.insertAdjacentHTML("beforeend", '<a href="https://ancre2.${suffixe}/">a</a>'); });
  const XHTML = "http://www.w3.org/1999/xhtml";
  essai("createDocument", () => { const d = document.implementation.createDocument(XHTML, "li" + "nk", null); const l = document.adoptNode(d.documentElement); l.setAttribute("rel", "dns-prefetch"); l.setAttribute("href", "//createdoc.${suffixe}"); document.head.append(l); });
  essai("importNode", () => { const d = document.implementation.createDocument(XHTML, "li" + "nk", null); const l = document.importNode(d.documentElement); l.rel = "preconnect"; l.href = "https://import.${suffixe}/"; document.head.appendChild(l); });
  essai("htmlDocument", () => { const d = document.implementation.createHTMLDocument(""); const l = d.createElement("li" + "nk"); l.rel = "dns-prefetch"; l.href = "//htmldoc.${suffixe}"; document.head.append(document.adoptNode(l)); });
  essai("fragment", () => { const d = document.implementation.createDocument(XHTML, "li" + "nk", null); const f = document.createDocumentFragment(); const p = document.createElement("p"); p.appendChild(document.adoptNode(d.documentElement)); f.append(p); p.firstChild.setAttribute("rel", "dns-prefetch"); p.firstChild.setAttribute("href", "//fragment.${suffixe}"); document.body.append(f); });
  essai("execCommand", () => { const d = document.createElement("div"); d.contentEditable = "true"; document.body.append(d); d.focus(); document.execCommand("insertHTML", false, L + " rel=dns-prefetch href=//exec.${suffixe}>"); });
  essai("srcdocEntites", () => { const f = document.createElement("iframe"); f.srcdoc = "<iframe srcdoc='&#38;lt;" + "link rel=dns-prefetch href=//srcdoc-dyn.${suffixe}>'></iframe>"; document.body.append(f); });
  document.getElementById("r").textContent = r.join(" ");
</script>`,
  });
  const { fenetre, fermer } = await lancer({ racine, env: envWidgets(), args: [`--log-net-log=${journalReseau}`] });
  for (const id of ["dns-statique", "dns-meta", "dns-entites", "dns-entites-hex"]) await expect(cadre(fenetre, id).locator("body")).toContainText("Affichage refusé");
  await expect(cadre(fenetre, "dns-script").locator("#r")).toHaveText(
    "create:TypeError inner:TypeError srcdoc:TypeError meta:TypeError image:passé ancre:passé createDocument:TypeError importNode:TypeError htmlDocument:TypeError fragment:TypeError execCommand:TypeError srcdocEntites:TypeError",
  );
  await expect(cadre(fenetre, "actus-tech").locator("#liste li").first()).toContainText("Un modèle de langage");
  // Filet de Chromium (blink-settings dnsPrefetchingEnabled=false) : même une page d'onglet, sans garde, ne résout pas ses
  // indices <link>.
  await ouvrirOnglet(fenetre, `${site.url}/indice-dns?h=onglet.${suffixe}`, { activer: true });
  await expect(fenetre.locator(onglets)).toContainText(["indice"]);
  // Témoin : une navigation d'onglet, elle, résout son nom (le journal réseau le voit).
  await ouvrirOnglet(fenetre, `http://temoin.${suffixe}/`, { activer: true });
  await attendre(3000);
  await fermer();
  const journal = readFileSync(journalReseau, "utf8");
  // Noms demandés au résolveur (pas les URL du journal, où le nom peut figurer en paramètre).
  const resolus = new RegExp(`"(?:qname|hostname|host)":"(?:[a-z-]+://)?([a-z0-9-]+\\.${suffixe.replace(/\./g, "\\.")})`, "g");
  const noms = [...new Set([...journal.matchAll(resolus)].map((m) => m[1]))];
  expect(noms).toEqual([`temoin.${suffixe}`]);
});

test("un favicon s'affiche dans la liste des onglets, cherché par le navigateur sans cookie (l'interface n'a pas de réseau)", async () => {
  const { fenetre, fermer } = await lancerWidgets(nouvelleRacine());
  await ouvrirOnglet(fenetre, `${site.url}/cookie`, { activer: true });
  await expect(fenetre.locator(onglets)).toContainText(["cookie"]);
  await ouvrirOnglet(fenetre, `${site.url}/avec-icone`, { activer: true });
  const icone = fenetre.locator(`${onglets} img`);
  await expect(icone).toHaveCount(1, { timeout: 10_000 });
  expect(await icone.getAttribute("src")).toMatch(/^webaios-icone:\/\/site\/\?u=/);
  await expect.poll(() => icone.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1);
  const demandes = site.journal.filter((r) => r.chemin === "/icone.png");
  expect(demandes.length).toBeGreaterThan(0);
  // La page l'a peut-être demandé elle-même (avec le cookie du profil) ; celle du navigateur n'en a aucun.
  expect(demandes.some((r) => r.cookie === undefined)).toBe(true);
  await fermer();
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

test("un affichage ne prend pas la place d'un autre widget ; réécrit par l'agent, il se recharge", async () => {
  const racine = nouvelleRacine();
  ecrireWidget(racine, "cible", { nom: "Cible", affichage: '<!doctype html><p id="cible">cible</p>' });
  ecrireWidget(racine, "pirate", {
    nom: "Pirate",
    affichage: AFFICHAGE.replace("</script>", `setTimeout(() => (location = "webaios-widget://cible/affichage.html"), 1000);</script>`),
    exemple: "pirate",
  });
  const { fenetre, fermer } = await lancerWidgets(racine);
  await expect(donnees(fenetre, "pirate")).toHaveText('"pirate"');
  await attendre(2500);
  await expect(cadre(fenetre, "pirate").locator("#cible")).toHaveCount(0);
  // L'agent réécrit l'affichage de « cible » : le cadre recharge le nouveau (même widget, nouvelle version).
  writeFileSync(join(racine, "accueil", "widgets", "cible", "affichage.html"), '<!doctype html><p id="cible">nouvelle version</p>');
  await expect(cadre(fenetre, "cible").locator("#cible")).toHaveText("nouvelle version", { timeout: 5000 });
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

test("une page dans un onglet n'a ni l'API de l'interface ni Node", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${site.url}/page-onglet`, { activer: true });
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await expect
    .poll(() => dansLaVue(app, "/page-onglet", "[typeof window.webaios, typeof require, typeof process].join(' ')"))
    .toBe("undefined undefined undefined");
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

// ---------------------------------------------------------------------------------------------------------------------
// Workflows des widgets (plan 8)

/** Widget en workflow : la page de test, ses liens extraits par du code, triés par Kev, puis leurs textes. */
function widgetVeille(racine: string): void {
  ecrireWidget(racine, "veille", {
    nom: "Veille",
    recolte: { minutes: 60 },
    config: { url: `${site.url}/liens` },
    workflow: {
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
    },
    fichiers: {
      "liens.mjs": "export default async (page) => page.liens;",
      "textes.mjs": "export default async (liens) => ({ liens: liens.map((l) => l.texte) });",
    },
    affichage: AFFICHAGE,
    exemple: { exemple: "veille" },
  });
}

test("un widget en workflow (source.page → code → ia.trier → code → sortie) se met à jour", async () => {
  const racine = nouvelleRacine();
  widgetVeille(racine);
  const profil = nouveauProfil();
  ecrireEtatWidget(profil, "veille");
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(donnees(fenetre, "veille")).toHaveText('{"exemple":"veille"}');
  await recolter(fenetre, "veille");
  await expect(donnees(fenetre, "veille")).toHaveText('{"liens":["Nouveau modèle IA"]}', { timeout: 20_000 });
  expect(lireJson(join(dossierWidgets(profil), "veille", "donnees.json"))).toEqual({ liens: ["Nouveau modèle IA"] });
  const executions = join(dossierWidgets(profil), "veille", "executions");
  expect(readdirSync(executions)).toHaveLength(1);
  // L'exécution, bloc par bloc (la page du constructeur l'affichera : plan 9, tâches 10 et 11).
  const execution = lireJson(join(executions, readdirSync(executions)[0]!));
  expect(execution.declencheur).toBe("manuelle");
  expect(execution.blocs.map((b: { id: string; statut: string }) => `${b.id}:${b.statut}`)).toEqual([
    "page:reussi",
    "liens:reussi",
    "tri:reussi",
    "textes:reussi",
    "sortie:reussi",
  ]);
  const sortieDe = (id: string) => JSON.stringify(execution.blocs.find((b: { id: string }) => b.id === id).sortie);
  expect(sortieDe("liens")).toContain("Recette de cuisine");
  expect(sortieDe("tri")).toContain("Nouveau modèle IA");
  expect(sortieDe("tri")).not.toContain("Recette de cuisine");
  await fermer();
});

test("un widget avec seulement recolte.mjs et un compte tourne comme avant", async () => {
  const racine = nouvelleRacine();
  widgetCompte(racine);
  const profil = nouveauProfil();
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(fenetre.getByTestId("bandeau-accord")).toContainText("127.0.0.1");
  await poserCookie(fenetre);
  await fenetre.getByTestId("bandeau-accord").getByRole("button", { name: "Autoriser…" }).click();
  await fenetre.getByTestId("carte-accord").getByRole("button", { name: "Autoriser" }).click();
  await expect(donnees(fenetre, "compte")).toHaveText('{"vu":"essai=1"}', { timeout: 20_000 });
  expect(lireJson(join(dossierWidgets(profil), "compte", "donnees.json"))).toEqual({ vu: "essai=1" });
  expect(lireJson(join(dossierWidgets(profil), "compte", "etat.json")).statut).toBe("ok");
  // Au lancement, sans accord, une exécution « accord requis » sans conteneur ; puis celle d'après l'accord.
  const executions = join(dossierWidgets(profil), "compte", "executions");
  const statuts = readdirSync(executions).sort().map((f) => lireJson(join(executions, f)).statut);
  expect(statuts).toEqual(["accord-requis", "reussie"]);
  await fermer();
});

test("refuser l'accord efface données, exécutions et mémoire", async () => {
  const racine = nouvelleRacine();
  widgetCompte(racine);
  const profil = nouveauProfil();
  // Ce qu'un accord passé a laissé : données, une exécution, la mémoire des blocs ; le widget attend un nouvel accord.
  const dossier = join(dossierWidgets(profil), "compte");
  mkdirSync(join(dossier, "executions"), { recursive: true });
  const maintenant = new Date().toISOString();
  ecrireEtatWidget(profil, "compte", {
    statut: "accord-requis",
    derniereMaj: maintenant,
    derniereTentative: maintenant,
    erreur: "Accord requis pour lire avec ton compte : 127.0.0.1",
    erreurNoyau: true,
  });
  writeFileSync(join(dossier, "donnees.json"), JSON.stringify({ vu: "secret" }));
  const id = maintenant.replace(/[:.]/g, "-");
  writeFileSync(
    join(dossier, "executions", `${id}.json`),
    JSON.stringify({
      version: 1,
      id,
      proprietaire: { type: "widget", id: "compte" },
      declencheur: "planifiee",
      debut: maintenant,
      fin: maintenant,
      statut: "reussie",
      blocs: [],
    }),
  );
  writeFileSync(join(dossier, "memoire.json"), JSON.stringify({ version: 1, blocs: { recolte: { type: "code", valeur: ["secret"] } } }));
  // Le journal du site est partagé par les tests : seules les lectures d'après comptent.
  const lectures = () => site.journal.filter((r) => r.chemin === "/lire-cookie?compte").length;
  const lecturesAvant = lectures();
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const bandeau = fenetre.getByTestId("bandeau-accord");
  await expect(bandeau).toContainText("127.0.0.1");
  // Rien n'est effacé avant la réponse de l'utilisateur.
  expect(existsSync(join(dossier, "donnees.json"))).toBe(true);
  expect(existsSync(join(dossier, "memoire.json"))).toBe(true);
  expect(readdirSync(join(dossier, "executions"))).toHaveLength(1);
  await bandeau.getByRole("button", { name: "Refuser" }).click();
  await expect(bandeau).toBeHidden();
  await expect.poll(() => existsSync(join(dossier, "donnees.json"))).toBe(false);
  await expect.poll(() => existsSync(join(dossier, "memoire.json"))).toBe(false);
  await expect.poll(() => existsSync(join(dossier, "executions")) && readdirSync(join(dossier, "executions")).length).toBeFalsy();
  expect(accords(profil)).toEqual({});
  expect(lireJson(join(dossier, "etat.json")).statut).toBe("accord-requis");
  await expect(donnees(fenetre, "compte")).toHaveText('{"exemple":"compte"}');
  expect(lectures()).toBe(lecturesAvant);
  await fermer();
});

test("un workflow.json invalide affiche « Workflow invalide : … » sur le widget ; les autres widgets se mettent à jour", async () => {
  const racine = nouvelleRacine();
  // Écrit à moitié par l'agent : JSON coupé.
  ecrireWidget(racine, "casse", {
    nom: "Cassé",
    recolte: { minutes: 60 },
    workflow: '{ "version": 1, "blocs": [ { "id": "page", "type": "source.pa',
    affichage: AFFICHAGE,
    exemple: { exemple: "casse" },
  });
  // Un cycle : refusé aussi, sans conteneur.
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
  ecrireWidget(racine, "bon", {
    nom: "Bon",
    recolte: { minutes: 60 },
    code: "export default async () => ({ bon: true });",
    affichage: AFFICHAGE,
    exemple: { exemple: "bon" },
  });
  widgetVeille(racine);
  ecrireDisposition(racine, [
    { id: "casse", x: 0, y: 0, l: 4, h: 3 },
    { id: "cycle", x: 4, y: 0, l: 4, h: 3 },
    { id: "bon", x: 8, y: 0, l: 4, h: 3 },
    { id: "veille", x: 0, y: 3, l: 4, h: 3 },
  ]);
  const profil = nouveauProfil();
  // Données d'une récolte passée : un workflow invalide ne les efface pas.
  mkdirSync(join(dossierWidgets(profil), "casse"), { recursive: true });
  writeFileSync(join(dossierWidgets(profil), "casse", "donnees.json"), JSON.stringify({ ancien: true }));
  // Sans état : tous récoltés au lancement.
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  await expect(donnees(fenetre, "bon")).toHaveText('{"bon":true}', { timeout: 20_000 });
  await expect(donnees(fenetre, "veille")).toHaveText('{"liens":["Nouveau modèle IA"]}', { timeout: 20_000 });
  await expect(fenetre.getByTestId("widget-casse")).toContainText("Workflow invalide : ", { timeout: 20_000 });
  await expect(fenetre.getByTestId("widget-cycle")).toContainText("Workflow invalide : ", { timeout: 20_000 });
  await expect(donnees(fenetre, "casse")).toHaveText('{"ancien":true}');
  expect(lireJson(join(dossierWidgets(profil), "casse", "donnees.json"))).toEqual({ ancien: true });
  expect(lireJson(join(dossierWidgets(profil), "casse", "etat.json")).erreur).toMatch(/^Workflow invalide : /);
  await fermer();
});

// Tâche 15 (plan 10) : la veille sur l'accueil

test("un widget en cours avec progression affiche « mise à jour… 7 / 12 »", async () => {
  const racine = nouvelleRacine();
  const declaration = { nom: "Veille longue", affichage: AFFICHAGE, exemple: { exemple: "veille" } };
  ecrireWidget(racine, "longue", declaration);
  ecrireDisposition(racine, [{ id: "longue", x: 0, y: 0, l: 4, h: 3 }]);
  const profil = nouveauProfil();
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const widget = fenetre.getByTestId("widget-longue");
  await expect(widget.getByTestId("titre-widget")).toHaveText("Veille longue");
  await expect(widget.getByTestId("progression")).toHaveCount(0);
  // Écrit après le démarrage (un « en-cours » trouvé au démarrage serait remis) ; la déclaration réécrite fait relire.
  const maintenant = new Date().toISOString();
  ecrireEtatWidget(profil, "longue", { statut: "en-cours", derniereMaj: null, derniereTentative: maintenant, progression: { faits: 7, total: 12 } });
  ecrireWidget(racine, "longue", declaration);
  await expect(widget.getByTestId("progression")).toHaveText("mise à jour… 7 / 12");
  await fermer();
});

test("un widget à heures affiche sa prochaine exécution (la plus proche avec une fréquence) ; jamais en attente d'accord", async () => {
  const racine = nouvelleRacine();
  // Une heure à trois heures d'ici : le texte attendu ne change pas pendant le test.
  const dans3h = new Date(Date.now() + 3 * 3600_000);
  const heure = `${String(dans3h.getHours()).padStart(2, "0")}:${String(dans3h.getMinutes()).padStart(2, "0")}`;
  ecrireWidget(racine, "matin", { nom: "Matin", recolte: { heures: [heure] }, affichage: AFFICHAGE, exemple: { exemple: "matin" } });
  ecrireWidget(racine, "horaire", { nom: "Horaire", recolte: { minutes: 60 }, affichage: AFFICHAGE, exemple: { exemple: "horaire" } });
  ecrireWidget(racine, "deux", { nom: "Deux", recolte: { minutes: 30, heures: [heure] }, affichage: AFFICHAGE, exemple: { exemple: "deux" } });
  ecrireWidget(racine, "attente", {
    nom: "Attente",
    recolte: { heures: [heure] },
    sources: { compte: ["mail.exemple.test"] },
    affichage: AFFICHAGE,
    exemple: { exemple: "attente" },
  });
  ecrireDisposition(racine, [
    { id: "matin", x: 0, y: 0, l: 4, h: 3 },
    { id: "horaire", x: 4, y: 0, l: 4, h: 3 },
    { id: "deux", x: 0, y: 3, l: 4, h: 3 },
    { id: "attente", x: 4, y: 3, l: 4, h: 3 },
  ]);
  const profil = nouveauProfil();
  const maintenant = new Date().toISOString();
  ecrireEtatWidget(profil, "matin", { statut: "ok", derniereMaj: maintenant, derniereTentative: maintenant, heures: { faite: "9999-12-31T23:59", echecs: null } });
  ecrireEtatWidget(profil, "horaire");
  const faite = { faite: "9999-12-31T23:59", echecs: null };
  ecrireEtatWidget(profil, "deux", { statut: "ok", derniereMaj: maintenant, derniereTentative: maintenant, heures: faite });
  ecrireEtatWidget(profil, "attente", { statut: "accord-requis", derniereMaj: null, derniereTentative: null, heures: faite });
  const { fenetre, fermer } = await lancerWidgets(racine, profil);
  const attendu = prochaineExecution([heure], new Date());
  expect(attendu).toMatch(/^(aujourd'hui|demain) \d\d:\d\d$/);
  await expect(fenetre.getByTestId("widget-matin").getByTestId("prochaine")).toHaveText(`prochaine : ${attendu}`);
  await expect(fenetre.getByTestId("widget-horaire").getByTestId("prochaine")).toHaveCount(0);
  // Fréquence de 30 min et heure dans 3 h : la fréquence, plus proche.
  const deux = prochaineExecution([heure], new Date(), { minutes: 30, derniereMaj: maintenant });
  expect(deux).not.toBe(attendu);
  await expect(fenetre.getByTestId("widget-deux").getByTestId("prochaine")).toHaveText(`prochaine : ${deux}`);
  await expect(fenetre.getByTestId("widget-attente")).toBeVisible();
  await expect(fenetre.getByTestId("widget-attente").getByTestId("prochaine")).toHaveCount(0);
  await fermer();
});
