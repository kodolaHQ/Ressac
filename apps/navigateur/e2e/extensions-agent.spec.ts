import { expect, test, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as serveurHttps } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { dansLaVue, lancer, nouveauProfil, nouvelleRacine, ouvrirOnglet, serveurTest } from "./aide";
import { ecrireExtensionAgent, installerStoreFactice } from "./extensions/fixtures";

// Extensions de l'agent (`<racine>/extensions/<id>/`, le ~/WebAiOs du test). Sans point d'entrée avant les tâches 14 et 17
// (P10), l'accord est posé au registre du profil avant le lancement, et chaque effet vérifié par un redémarrage. Les
// tests « demander dans un espace privé » et « la carte revient au rechargement » sont ceux de la tâche 17 (MCP).

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => {
  serveur = await serveurTest();
});
test.afterAll(async () => {
  await serveur.fermer();
});

const HOTE = "http://127.0.0.1/*";
const manifeste = (matches: string[]) => ({
  manifest_version: 3,
  name: "Cacheur de l'agent",
  version: "1.0.0",
  content_scripts: [{ matches, css: ["cache.css"] }],
});
const CACHE = "#cache-moi { display: none !important; }\n";
const CACHE_TOUT = "#cache-moi, #reste { display: none !important; }\n";
/** La portée du cacheur sur 127.0.0.1, telle que la carte l'aurait montrée. */
const ACCORD = { permissions: [], hotes: [HOTE], reseau: [], tousLesSites: false, scriptsTousLesSites: false, scripts: true };

type Entree = { idChrome: string | null; accord: unknown; profils: string[]; modifieeLe: string | null; desactivee: { raison: string } | null };
const entree = (accord: unknown) => ({
  source: "agent",
  idChrome: null,
  nom: "Cacheur de l'agent",
  version: "1.0.0",
  accord,
  profils: ["defaut"],
  epinglee: false,
  modifieeLe: null,
  desactivee: null,
  majEnAttente: null,
  vues: {},
});

/** Écrit un registre dans `dossier` (`etat.json`) avec l'entrée `agent:cacheur`. */
function poserRegistre(dossier: string, x: unknown): void {
  mkdirSync(dossier, { recursive: true });
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { "agent:cacheur": x } }));
}
const lireEntree = (profil: string) =>
  (JSON.parse(readFileSync(join(profil, "extensions", "etat.json"), "utf8")) as { extensions: Record<string, Entree> }).extensions["agent:cacheur"];

/** `display` de #cache-moi et #reste dans l'onglet de cache.html. */
const affichage = (app: ElectronApplication) =>
  dansLaVue(app, "cache.html", "[getComputedStyle(document.getElementById('cache-moi')).display, getComputedStyle(document.getElementById('reste')).display].join()");

const extensionsDuProfil = (app: ElectronApplication) =>
  app.evaluate(({ session }) => session.fromPartition("persist:webaios").extensions.getAllExtensions().map((e) => e.name));

/** Lance, ouvre cache.html et rend ce qu'on y voit une fois la page chargée (après un délai pour les extensions). */
async function voir(profil: string, racine: string): Promise<{ affiche: unknown; extensions: string[] }> {
  const { app, fenetre, fermer } = await lancer({ profil, racine });
  try {
    await ouvrirOnglet(fenetre, `${serveur.url}/cache.html`);
    await expect.poll(() => dansLaVue(app, "cache.html", "document.readyState")).toBe("complete");
    return { affiche: await affichage(app), extensions: await extensionsDuProfil(app) };
  } finally {
    await fermer();
  }
}

test("une extension de l'agent posée dans ~/WebAiOs/extensions n'est jamais chargée sans accord (redémarrage compris)", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  ecrireExtensionAgent(racine, "cacheur", { "manifest.json": manifeste([HOTE]), "cache.css": CACHE });
  for (let i = 0; i < 2; i++) {
    const vu = await voir(profil, racine);
    expect(vu.affiche).toBe("block,block");
    expect(vu.extensions).toEqual([]);
  }
  expect(existsSync(join(profil, "extensions", "copies", "cacheur"))).toBe(false);
});

test("un faux accord écrit dans ~/WebAiOs/extensions n'active rien", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  ecrireExtensionAgent(racine, "cacheur", { "manifest.json": manifeste([HOTE]), "cache.css": CACHE });
  // Le registre tel que WebAiOs l'écrirait, mais dans le dossier de l'agent (et dans le dossier de l'extension).
  poserRegistre(join(racine, "extensions"), entree(ACCORD));
  poserRegistre(join(racine, "extensions", "cacheur"), entree(ACCORD));
  const vu = await voir(profil, racine);
  expect(vu.affiche).toBe("block,block");
  expect(vu.extensions).toEqual([]);
  expect(existsSync(join(profil, "extensions", "copies", "cacheur"))).toBe(false);
});

test("accordée, elle cache #cache-moi ; modifiée sans nouveau droit puis rechargée, elle passe sans carte", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  ecrireExtensionAgent(racine, "cacheur", { "manifest.json": manifeste([HOTE]), "cache.css": CACHE });
  poserRegistre(join(profil, "extensions"), entree(ACCORD));

  let lance = await lancer({ profil, racine });
  try {
    await ouvrirOnglet(lance.fenetre, `${serveur.url}/cache.html`);
    await expect.poll(() => affichage(lance.app), { timeout: 10_000 }).toBe("none,block");
  } finally {
    await lance.fermer();
  }
  const premiere = lireEntree(profil)!;
  expect(premiere.modifieeLe).not.toBeNull();
  // L'id que Chromium a donné à la copie est noté au registre.
  expect(premiere.idChrome).toMatch(/^[a-p]{32}$/);

  // Modifiée par l'agent (même portée) : rechargée au démarrage, sans carte.
  ecrireExtensionAgent(racine, "cacheur", { "cache.css": CACHE_TOUT });
  lance = await lancer({ profil, racine });
  try {
    await ouvrirOnglet(lance.fenetre, `${serveur.url}/cache.html`);
    await expect.poll(() => affichage(lance.app), { timeout: 10_000 }).toBe("none,none");
    // Aucune carte d'accord dans la fenêtre.
    await expect(lance.fenetre.getByText("Cacheur de l'agent")).toHaveCount(0);
  } finally {
    await lance.fermer();
  }
  const seconde = lireEntree(profil)!;
  expect(seconde.desactivee).toBeNull();
  expect(seconde.modifieeLe).not.toBe(premiere.modifieeLe);
  expect(seconde.accord).toEqual(ACCORD);
});

test("modifiée avec un nouveau site : désactivée, plus chargée, l'accord gardé", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  ecrireExtensionAgent(racine, "cacheur", { "manifest.json": manifeste([HOTE, "https://exemple.com/*"]), "cache.css": CACHE });
  poserRegistre(join(profil, "extensions"), entree(ACCORD));
  const vu = await voir(profil, racine);
  expect(vu.affiche).toBe("block,block");
  expect(vu.extensions).toEqual([]);
  const x = lireEntree(profil)!;
  expect(x.desactivee?.raison).toBe("portee-elargie");
  expect(x.accord).toEqual(ACCORD);
});

// --- Réseau des extensions de l'agent (tâche 12)
//
// Un serveur https local (certificat fait par le test) répond pour trois noms : accorde.test (dans `reseau` de
// l'extension), hote.test (dans ses hôtes), autre.test (ni l'un ni l'autre). Chromium les résout vers ce serveur
// (`--host-resolver-rules`, port 443 → port du serveur : la CSP `https://accorde.test` vise le port 443) et accepte son
// certificat (`--ignore-certificate-errors`). Le serveur note chaque requête (hôte et chemin) : c'est la preuve.

type Coup = { hote: string; chemin: string };
let https: { port: number; coups: Coup[]; fermer(): Promise<void> };
let dossierCertificat: string;

test.beforeAll(async () => {
  dossierCertificat = mkdtempSync(join(tmpdir(), "webaios-cert-"));
  const [cle, cert] = [join(dossierCertificat, "cle.pem"), join(dossierCertificat, "cert.pem")];
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", cle, "-out", cert, "-days", "2", "-subj", "/CN=accorde.test"], {
    stdio: "ignore",
  });
  const coups: Coup[] = [];
  const noter = (hote: string | undefined, url: string | undefined) => coups.push({ hote: (hote ?? "").split(":")[0]!, chemin: (url ?? "").split("?")[0]! });
  const serveur = serveurHttps({ key: readFileSync(cle), cert: readFileSync(cert) }, (req, res) => {
    noter(req.headers.host, req.url);
    req.resume();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(`<title>${req.url}</title>ok`);
  });
  serveur.on("upgrade", (req, socket) => {
    noter(req.headers.host, req.url);
    socket.destroy();
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  https = {
    port: (serveur.address() as AddressInfo).port,
    coups,
    fermer: () => new Promise((ok) => serveur.close(() => ok())),
  };
});
test.afterAll(async () => {
  await https.fermer();
  rmSync(dossierCertificat, { recursive: true, force: true });
});

const argsReseau = () => [
  `--host-resolver-rules=${["accorde.test", "hote.test", "autre.test"].map((h) => `MAP ${h}:443 127.0.0.1:${https.port}`).join(", ")}`,
  "--ignore-certificate-errors",
];
const coupsVers = (hote: string, chemin?: string) => https.coups.filter((c) => c.hote === hote && (chemin === undefined || c.chemin === chemin));

/**
 * L'extension « réseau » de l'agent : `reseau` accorde.test, hôtes https://hote.test/*. Au démarrage, son service
 * worker envoie vers accorde.test et autre.test (fetch, WebSocket), puis essaie les API gardées et note ce qu'il
 * obtient dans `storage.local` (`resultats`). Sa page (`page.html`, aussi sa popup) fait de même pour fetch, sendBeacon,
 * WebSocket, WebRTC, navigation et ouverture de fenêtre, et écrit ce qu'elle voit dans `document.title` (JSON).
 */
const EXTENSION_RESEAU = {
  "manifest.json": {
    manifest_version: 3,
    name: "Réseau de l'agent",
    version: "1.0.0",
    permissions: ["cookies", "declarativeNetRequest", "storage", "tabs"],
    host_permissions: ["https://hote.test/*"],
    background: { service_worker: "fond.js" },
    action: { default_popup: "page.html" },
  },
  "webaios.json": { reseau: ["accorde.test"] },
  "fond.js": `const resultats = {};
const essai = async (nom, f) => {
  try {
    resultats[nom] = { ok: await f() ?? null };
  } catch (e) {
    resultats[nom] = { erreur: String(e && e.message) };
  }
};
for (const h of ["accorde.test", "autre.test"]) {
  fetch("https://" + h + "/sw-fetch").catch(() => {});
  try { new WebSocket("wss://" + h + "/sw-ws").onerror = () => {}; } catch {}
}
(async () => {
  await essai("ongletRefuse", () => chrome.tabs.create({ url: "https://autre.test/onglet-refuse" }).then((t) => t && t.id));
  await essai("ongletDonnees", () => chrome.tabs.create({ url: "data:text/html,x" }).then((t) => t && t.id));
  await essai("ongletPermis", () => chrome.tabs.create({ url: "https://hote.test/onglet-permis", active: false }).then((t) => typeof (t && t.id)));
  await essai("fenetreRefusee", () => chrome.windows.create({ url: "https://autre.test/fenetre-refusee" }).then(() => "ouverte"));
  const regle = (id, action) => ({ removeRuleIds: [id], addRules: [{ id, priority: 1, action, condition: { urlFilter: "/rien-" + id, resourceTypes: ["xmlhttprequest"] } }] });
  await essai("dnrRedirect", () => chrome.declarativeNetRequest.updateDynamicRules(regle(1, { type: "redirect", redirect: { url: "https://autre.test/" } })).then(() => "acceptee"));
  await essai("dnrEntetes", () => chrome.declarativeNetRequest.updateSessionRules(regle(2, { type: "modifyHeaders", requestHeaders: [{ header: "x", operation: "set", value: "y" }] })).then(() => "acceptee"));
  await essai("dnrBlock", () => chrome.declarativeNetRequest.updateDynamicRules(regle(3, { type: "block" })).then(() => "acceptee"));
  await essai("dnrRegles", () => chrome.declarativeNetRequest.getDynamicRules().then((r) => r.map((x) => x.action.type)));
  await essai("permissionsDownloads", () => chrome.permissions.request({ permissions: ["downloads"] }));
  await essai("rtc", () => typeof globalThis.RTCPeerConnection);
  await essai("cookieRefuse", () => chrome.cookies.set({ url: "https://autre.test/", name: "fuite", value: "secret" }).then(() => "pose"));
  await essai("cookiePermis", () => chrome.cookies.set({ url: "https://hote.test/", name: "reglage", value: "1" }).then((c) => c && c.name));
  await essai("cookieRappel", () => new Promise((ok) => chrome.cookies.set({ url: "https://autre.test/", name: "fuite", value: "x" }, () => ok(chrome.runtime.lastError && chrome.runtime.lastError.message))));
  await chrome.storage.local.set({ resultats });
})();
// Ordres d'une page (ordre.html?<ordre>) : popup vers une adresse absolue, ou popup qui sonde ses cadres.
chrome.runtime.onMessage.addListener((m, _expediteur, repondre) => {
  (async () => {
    if (m === "popup-fuite") {
      await chrome.action.setPopup({ popup: "https://autre.test/popup-fuite" });
      await chrome.action.openPopup().catch(() => {});
    } else if (m === "popup-cadres") {
      await chrome.action.setPopup({ popup: "cadre.html" });
      await chrome.action.openPopup();
    }
    repondre("fait");
  })().catch((e) => repondre(String(e && e.message)));
  return true;
});
`,
  "ordre.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="ordre.js"></script></body></html>',
  "ordre.js": `chrome.runtime.sendMessage(location.search.slice(1)).then((r) => (document.title = String(r)), (e) => (document.title = "erreur " + e.message));
`,
  "cadre.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="cadre.js"></script></body></html>',
  "cadre.js": `(async () => {
 try {
  const sonder = async (w, nom) => {
    const c = w.chrome;
    const d = c && c.declarativeNetRequest && Object.getOwnPropertyDescriptor(c.declarativeNetRequest, "updateDynamicRules");
    let dnr;
    try {
      await c.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [7], addRules: [{ id: 7, priority: 1, action: { type: "redirect", redirect: { url: "https://autre.test/fuite-" + nom } }, condition: { urlFilter: "/rien-cadre", resourceTypes: ["xmlhttprequest"] } }] });
      dnr = "acceptee";
    } catch (e) { dnr = String(e && e.message); }
    let rtc;
    try { new w.RTCPeerConnection(); rtc = "creee"; } catch (e) { rtc = String(e && e.message); }
    return { chrome: typeof c, tabs: typeof (c && c.tabs), dnrFige: d ? d.configurable === false : null, dnr, rtc: typeof w.RTCPeerConnection, rtcEssai: rtc, webaios: typeof w.__webaios, protocole: w.location.protocol };
  };
  const vu = {};
  const vide = document.body.appendChild(document.createElement("iframe"));
  vu.blank = await sonder(vide.contentWindow, "blank");
  document.body.appendChild(document.createElement("iframe"));
  vu.index = await sonder(window[1], "index");
  const hote = document.body.appendChild(document.createElement("div")).attachShadow({ mode: "open" });
  hote.appendChild(document.createElement("iframe"));
  vu.ombre = await sonder(hote.querySelector("iframe").contentWindow, "ombre");
  const imbrique = document.body.appendChild(document.createElement("iframe"));
  imbrique.srcdoc = "<p>x</p>";
  vu.srcdocTot = await sonder(window[2], "srcdocTot");
  await new Promise((ok) => imbrique.addEventListener("load", ok, { once: true }));
  window[2].document.body.appendChild(window[2].document.createElement("iframe"));
  vu.petit = await sonder(window[2][0], "petit");
  const doc = document.createElement("iframe");
  doc.srcdoc = "<p>x</p>";
  document.body.appendChild(doc);
  await new Promise((ok) => doc.addEventListener("load", ok, { once: true }));
  vu.srcdoc = await sonder(window[3], "srcdoc");
  vu.frames = typeof window[0];
  vu.regles = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.action.type);
  document.title = JSON.stringify(vu);
 } catch (e) { document.title = "erreur " + e.stack; }
})();
`,
  "page.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="page.js"></script></body></html>',
  "page.js": `const vu = { rtc: typeof RTCPeerConnection, rtcWebkit: typeof webkitRTCPeerConnection, canal: typeof RTCDataChannel };
for (const h of ["accorde.test", "autre.test"]) {
  fetch("https://" + h + "/page-fetch").catch(() => {});
  try { navigator.sendBeacon("https://" + h + "/page-beacon", "x"); } catch {}
  try { new WebSocket("wss://" + h + "/page-ws").onerror = () => {}; } catch {}
}
try { vu.ouverture = String(window.open("https://hote.test/page-ouvre")); } catch (e) { vu.ouverture = "erreur"; }
document.title = JSON.stringify(vu);
setTimeout(() => { location.href = "https://autre.test/page-navigue"; }, 300);
`,
};

const ACCORD_RESEAU = {
  permissions: ["cookies", "declarativeNetRequest", "storage", "tabs"],
  hotes: ["https://hote.test/*"],
  reseau: ["accorde.test"],
  tousLesSites: false,
  scriptsTousLesSites: false,
  scripts: false,
};

function poserReseau(profil: string, racine: string): void {
  ecrireExtensionAgent(racine, "reseau", EXTENSION_RESEAU);
  mkdirSync(join(profil, "extensions"), { recursive: true });
  writeFileSync(
    join(profil, "extensions", "etat.json"),
    JSON.stringify({ version: 1, toutesCoupees: false, extensions: { "agent:reseau": { ...entree(ACCORD_RESEAU), nom: "Réseau de l'agent" } } }),
  );
}

/** L'id Chromium de l'extension chargée sous ce nom dans le profil par défaut. */
const idChargee = (app: ElectronApplication, nom: string) =>
  app.evaluate(({ session }, nom) => session.fromPartition("persist:webaios").extensions.getAllExtensions().find((e) => e.name === nom)?.id ?? null, nom);

/** Ouvre une page de l'extension dans une fenêtre cachée de la session du profil (comme sa popup) ; rend son titre. */
const ouvrirPage = (app: ElectronApplication, url: string) =>
  app.evaluate(async ({ BrowserWindow, session }, url) => {
    const f = new BrowserWindow({
      show: false,
      webPreferences: { session: session.fromPartition("persist:webaios"), sandbox: true, contextIsolation: true, nodeIntegrationInSubFrames: true },
    });
    await f.webContents.loadURL(url);
    await new Promise((ok) => setTimeout(ok, 1500));
    const r = { titre: f.webContents.getTitle(), url: f.webContents.getURL(), fenetres: BrowserWindow.getAllWindows().length };
    f.destroy();
    return r;
  }, url);

/** Les résultats notés par le service worker (`storage.local`), lus depuis une page de l'extension. */
const resultatsFond = (app: ElectronApplication, id: string) =>
  app.evaluate(async ({ BrowserWindow, session }, id) => {
    const f = new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition("persist:webaios"), sandbox: true, contextIsolation: true } });
    try {
      await f.webContents.loadURL(`chrome-extension://${id}/page.html`);
      return await f.webContents.executeJavaScript("chrome.storage.local.get('resultats').then((r) => r.resultats ?? null)");
    } finally {
      f.destroy();
    }
  }, id);

// WebSocket : la CSP de la copie porte `https://` et `wss://` de chaque domaine accordé (R12-B).
test("le service worker ne peut rien envoyer vers un domaine non accordé (fetch, WebSocket) ; vers le domaine accordé, oui", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  poserReseau(profil, racine);
  const { app, fermer } = await lancer({ profil, racine, args: argsReseau() });
  try {
    await expect.poll(() => coupsVers("accorde.test", "/sw-fetch").length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => coupsVers("accorde.test", "/sw-ws").length).toBeGreaterThan(0);
    await new Promise((ok) => setTimeout(ok, 1000));
    expect(coupsVers("autre.test", "/sw-fetch")).toEqual([]);
    expect(coupsVers("autre.test", "/sw-ws")).toEqual([]);
  } finally {
    await fermer();
  }
});

test("sa popup et ses pages non plus (fetch, sendBeacon, WebSocket, navigation, window.open) ; RTCPeerConnection est absent de ses pages", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  poserReseau(profil, racine);
  const { app, fermer } = await lancer({ profil, racine, args: argsReseau() });
  try {
    let id: string | null = null;
    await expect.poll(async () => (id = await idChargee(app, "Réseau de l'agent")), { timeout: 15_000 }).toMatch(/^[a-p]{32}$/);
    const page = await ouvrirPage(app, `chrome-extension://${id}/page.html`);
    expect(JSON.parse(page.titre)).toEqual({ rtc: "undefined", rtcWebkit: "undefined", canal: "undefined", ouverture: "null" });
    // La navigation vers autre.test a été refusée : la page est restée la sienne.
    expect(page.url).toBe(`chrome-extension://${id}/page.html`);
    await expect.poll(() => coupsVers("accorde.test", "/page-fetch").length).toBeGreaterThan(0);
    await expect.poll(() => coupsVers("accorde.test", "/page-beacon").length).toBeGreaterThan(0);
    await expect.poll(() => coupsVers("accorde.test", "/page-ws").length).toBeGreaterThan(0);
    for (const chemin of ["/page-fetch", "/page-beacon", "/page-ws", "/page-navigue"]) expect(coupsVers("autre.test", chemin)).toEqual([]);
    expect(coupsVers("hote.test", "/page-ouvre")).toEqual([]);
  } finally {
    await fermer();
  }
});

test("tabs.create vers un domaine non accordé est refusé ; vers un site de ses hôtes, ouvert ; updateDynamicRules avec redirect est refusé, avec block accepté ; chrome.permissions.request({ permissions: [\"downloads\"] }) rend false", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  poserReseau(profil, racine);
  const { app, fermer } = await lancer({ profil, racine, args: argsReseau() });
  try {
    let id: string | null = null;
    await expect.poll(async () => (id = await idChargee(app, "Réseau de l'agent")), { timeout: 15_000 }).toMatch(/^[a-p]{32}$/);
    let r: Record<string, unknown> | null = null;
    await expect.poll(async () => (r = await resultatsFond(app, id!)), { timeout: 15_000 }).not.toBeNull();
    expect(r).toEqual({
      ongletRefuse: { erreur: "URL refusée par WebAiOs" },
      ongletDonnees: { erreur: "URL refusée par WebAiOs" },
      ongletPermis: { ok: "number" },
      fenetreRefusee: { erreur: "URL refusée par WebAiOs" },
      dnrRedirect: { erreur: "Règle DNR refusée par WebAiOs (redirect)" },
      dnrEntetes: { erreur: "Règle DNR refusée par WebAiOs (modifyHeaders)" },
      dnrBlock: { ok: "acceptee" },
      dnrRegles: { ok: ["block"] },
      permissionsDownloads: { ok: false },
      rtc: { ok: "undefined" },
      cookieRefuse: { erreur: "Site refusé par WebAiOs" },
      cookiePermis: { ok: "reglage" },
      cookieRappel: { ok: "Site refusé par WebAiOs" },
    });
    // Aucun cookie posé pour autre.test.
    const cookies = await app.evaluate(({ session }) => session.fromPartition("persist:webaios").cookies.get({ url: "https://autre.test/" }));
    expect(cookies).toEqual([]);
    // L'onglet permis s'est ouvert sur hote.test ; rien n'a atteint autre.test.
    await expect.poll(() => coupsVers("hote.test", "/onglet-permis").length).toBeGreaterThan(0);
    expect(coupsVers("autre.test", "/onglet-refuse")).toEqual([]);
    expect(coupsVers("autre.test", "/fenetre-refusee")).toEqual([]);
  } finally {
    await fermer();
  }
});

// Branche B (reseau.ts) : aucun session.webRequest, qui couperait le declarativeNetRequest de toute la session. Ce test
// remplace « l'écouteur ne coupe pas le chrome.webRequest d'une extension Store » (chrome.webRequest ne se déclenche
// jamais dans Electron 45, tâche 1) : ce qui est observable, c'est qu'une extension de l'agent chargée ne gêne ni le
// blocage d'une extension du Store, ni ses requêtes, ni les pages du profil.
test("avec une extension de l'agent chargée, une extension du Store bloque encore (DNR) et envoie où elle veut ; les pages se chargent", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  poserReseau(profil, racine);
  installerStoreFactice(profil, "sonde-reseau-store", { profils: ["defaut"] });
  installerStoreFactice(profil, "bloqueur-statique", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil, racine, args: argsReseau() });
  try {
    await expect.poll(async () => idChargee(app, "Réseau de l'agent"), { timeout: 15_000 }).toMatch(/^[a-p]{32}$/);
    await expect.poll(() => coupsVers("autre.test", "/store-fetch").length, { timeout: 15_000 }).toBeGreaterThan(0);
    await ouvrirOnglet(fenetre, "https://autre.test/onglet-site");
    await expect.poll(() => coupsVers("autre.test", "/onglet-site").length).toBeGreaterThan(0);
    await ouvrirOnglet(fenetre, `${serveur.url}/pub.html?avec-agent`);
    await expect.poll(() => dansLaVue(app, "pub.html?avec-agent", "document.title")).toMatch(/^pub /);
    // Rechargée jusqu'à ce que le ruleset du manifeste soit activé (au démarrage de son fond minimal).
    const recharger = () =>
      app.evaluate(async ({ webContents }) => {
        const w = webContents.getAllWebContents().find((x) => x.getURL().includes("pub.html?avec-agent"));
        await w?.loadURL(w.getURL()).catch(() => {});
        return w?.getTitle();
      });
    await expect.poll(recharger, { timeout: 10_000 }).toBe("pub bloquée");
    // L'extension de l'agent n'a rien envoyé hors de son accord pendant ce temps.
    expect(coupsVers("autre.test", "/sw-fetch")).toEqual([]);
  } finally {
    await fermer();
  }
});

/** Une page de l'extension donne un ordre à son service worker (ordre.html?<ordre>) ; rend sa réponse. */
const ordonner = async (app: ElectronApplication, id: string, ordre: string) => {
  const r = await ouvrirPage(app, `chrome-extension://${id}/ordre.html?${ordre}`);
  return r.titre;
};

test("chrome.action.setPopup vers une adresse absolue puis openPopup : rien n'est chargé (le serveur ne reçoit rien)", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  poserReseau(profil, racine);
  const { app, fenetre, fermer } = await lancer({ profil, racine, args: argsReseau() });
  try {
    let id: string | null = null;
    await expect.poll(async () => (id = await idChargee(app, "Réseau de l'agent")), { timeout: 15_000 }).toMatch(/^[a-p]{32}$/);
    // Un onglet actif dans la fenêtre : openPopup a où s'ancrer.
    await ouvrirOnglet(fenetre, "https://hote.test/ancre");
    await expect.poll(() => coupsVers("hote.test", "/ancre").length).toBeGreaterThan(0);
    expect(await ordonner(app, id!, "popup-fuite")).toBe("fait");
    await new Promise((ok) => setTimeout(ok, 1500));
    expect(coupsVers("autre.test", "/popup-fuite")).toEqual([]);
  } finally {
    await fermer();
  }
});

// Mesuré (Electron 45) : un cadre about:blank ou srcdoc d'une page d'extension a l'origine de la page mais aucune API
// d'extension (`chrome` sans tabs ni declarativeNetRequest) ; il a en revanche RTCPeerConnection. Le preload des
// correctifs, qui tourne dans les sous-cadres des popups et des onglets, l'en prive (voir task-12-report, fix round 1).
test("dans sa popup, un cadre about:blank, srcdoc, imbriqué ou dans une racine fantôme n'a ni RTCPeerConnection ni le moyen de poser une redirection DNR", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  poserReseau(profil, racine);
  const { app, fenetre, fermer } = await lancer({ profil, racine, args: argsReseau() });
  try {
    let id: string | null = null;
    await expect.poll(async () => (id = await idChargee(app, "Réseau de l'agent")), { timeout: 15_000 }).toMatch(/^[a-p]{32}$/);
    await ouvrirOnglet(fenetre, "https://hote.test/ancre-cadres");
    await expect.poll(() => coupsVers("hote.test", "/ancre-cadres").length).toBeGreaterThan(0);
    expect(await ordonner(app, id!, "popup-cadres")).toBe("fait");
    // La popup de la bibliothèque (fenêtre cachée en test) sur cadre.html : son titre est le rapport.
    const titre = () =>
      app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().endsWith("/cadre.html"))?.getTitle() ?? null);
    await expect.poll(titre, { timeout: 10_000 }).toMatch(/^\{/);
    const vu = JSON.parse((await titre())!) as Record<string, { rtc: string; rtcEssai: string; dnr: string; tabs: string; protocole: string }> & { regles: string[] };
    for (const cadre of ["blank", "index", "ombre", "srcdocTot", "petit", "srcdoc"]) {
      expect(vu[cadre]!.protocole).toBe("about:");
      expect(vu[cadre]!.rtc).toBe("undefined");
      expect(vu[cadre]!.rtcEssai).not.toBe("creee");
      expect(vu[cadre]!.tabs).toBe("undefined");
      expect(vu[cadre]!.dnr).not.toBe("acceptee");
    }
    // Aucune redirection posée : seule la règle block du démarrage.
    expect(vu.regles).toEqual(["block"]);
  } finally {
    await fermer();
  }
});
