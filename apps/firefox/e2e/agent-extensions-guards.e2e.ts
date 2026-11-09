import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeAgentExtension } from "./extensions/fixtures";
import { installAddon } from "./addons";
import { agentAddons, grant, inPage, launchWithAmo, openTab } from "./agent-extensions";
import { waitFor } from "./firefox";
import type { LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";

// The agent extensions' network guard. Firefox sends every https request to a recording proxy, which answers CONNECT and
// serves the tunnel with a self-signed certificate (Firefox's certificate checks turned off for the run). « Nothing
// leaves » is checked by `hits`: what the proxy saw, by host and path (a bare tunnel is « (connexion) »).
const ID = "reseau@agent.webaios";

type Hit = { host: string; path: string };
let proxy: { port: number; hits: Hit[]; close(): Promise<void> };
let certs: string;
let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer();
  certs = mkdtempSync(path.join(os.tmpdir(), "webaios-cert-"));
  const [key, cert] = [path.join(certs, "key.pem"), path.join(certs, "cert.pem")];
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=accorde.test"], { stdio: "ignore" });
  const hits: Hit[] = [];
  const note = (host: string | undefined, url: string | undefined) => hits.push({ host: (host ?? "").split(":")[0]!, path: (url ?? "").split("?")[0]! });
  const tls = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    note(req.headers.host, req.url);
    req.resume();
    const path = (req.url ?? "").split("?")[0];
    // The read's image delays its load end.
    if (path === "/lent.png") return void setTimeout(() => res.writeHead(200, { "Content-Type": "image/png" }).end(), 4000);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(path === "/formulaire" ? FORM_PAGE : path === "/lecture" ? READ_PAGE : `<title>${req.url}</title>ok`);
  });
  tls.on("upgrade", (req, socket) => {
    note(req.headers.host, req.url);
    socket.destroy();
  });
  const http = createServer((req, res) => {
    // A plain http request through the proxy: absolute URL.
    const u = new URL(req.url ?? "/", "http://x");
    note(u.host, u.pathname);
    res.writeHead(200, { "Content-Type": "text/html" }).end("<title>http</title>");
  });
  http.on("connect", (req, socket) => {
    note(req.url, "(connexion)");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    tls.emit("connection", socket);
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  proxy = {
    port: (http.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise((ok) => {
        http.close(() => ok());
        http.closeAllConnections();
      }),
  };
});
afterAll(async () => {
  await proxy?.close();
  await server?.close();
  rmSync(certs, { recursive: true, force: true });
});

// Each test sees only its own app's requests.
beforeEach(() => void (proxy.hits.length = 0));

const hitsTo = (host: string, path?: string) => proxy.hits.filter((c) => c.host === host && (path === undefined || c.path === path));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(100);
  }
}

/**
 * The network extension, the files these tests use: `reseau` accorde.test, hosts
 * https://hote.test/*. Its background sends to accorde.test and autre.test (fetch, WebSocket), then tries the guarded
 * APIs and keeps what it got in `storage.local` (`resultats`). Firefox: `clients-type` answers typeof clients (absent
 * from a background page, spike S2); `resultats.html` shows the results in its title.
 */
const EXTENSION_NETWORK = {
  "manifest.json": {
    manifest_version: 3,
    name: "Réseau de l'agent",
    version: "1.0.0",
    permissions: ["cookies", "declarativeNetRequest", "storage", "tabs"],
    host_permissions: ["https://hote.test/*"],
    background: { service_worker: "fond.js" },
    action: { default_popup: "page.html" },
  },
  "webaios.json": { network: ["accorde.test"] },
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
  await chrome.storage.local.set({ resultats });
})();
chrome.runtime.onMessage.addListener((m, _expediteur, repondre) => {
  (async () => {
    if (m === "popup-fuite") {
      await chrome.action.setPopup({ popup: "https://autre.test/popup-fuite" });
      await chrome.action.openPopup().catch(() => {});
    } else if (m === "popup-cadres") {
      await chrome.action.setPopup({ popup: "cadre.html" });
    } else if (m === "popup-capture") {
      await chrome.action.setPopup({ popup: "capture.html" });
    } else if (m === "clients-type") {
      repondre(typeof clients);
      return;
    } else if (m === "desinstallation") {
      repondre(await chrome.runtime.setUninstallURL("https://autre.test/desinstall").then(() => "posee", (e) => "erreur " + (e && e.message)));
      return;
    }
    repondre("fait");
  })().catch((e) => repondre(String(e && e.message)));
  return true;
});
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
  "resultats.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="resultats.js"></script></body></html>',
  "resultats.js": `const lire = () => chrome.storage.local.get("resultats").then((r) => (r.resultats ? (document.title = JSON.stringify(r.resultats)) : setTimeout(lire, 200)));
lire();
`,
  "liens.html":
    '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="on"><title>attente</title><link rel="dns-prefetch" href="https://statique-dns.autre.test/"><link rel="preconnect" href="https://statique-preco.autre.test/"></head><body><script src="liens.js"></script></body></html>',
  "liens.js": `const vu = {};
const poser = (rel, hote, facon) => {
  const l = document.createElement("link");
  try {
    if (facon === "attribut") { l.setAttribute("rel", rel); l.setAttribute("href", "https://" + hote + "/"); }
    else if (facon === "liste") { l.relList.add(rel); l.href = "https://" + hote + "/"; }
    else { l.rel = rel; l.href = "https://" + hote + "/"; }
    document.head.appendChild(l);
    vu[hote] = "pose";
  } catch (e) { vu[hote] = String(e && e.message); }
};
poser("preconnect", "autre.test", "propriete");
for (const rel of ["dns-prefetch", "preconnect", "prefetch", "prerender", "preload", "modulepreload"]) {
  poser(rel, rel + ".autre.test", "propriete");
  poser(rel, rel + "-attr.autre.test", "attribut");
  poser(rel, rel + "-liste.autre.test", "liste");
}
poser("preconnect", "hote.test", "propriete");
document.title = JSON.stringify(vu);
`,
  "tableaux.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="tableaux.js"></script></body></html>',
  "tableaux.js": `(async () => {
  const regle = (id) => ({ id, priority: 1, action: { type: "redirect", redirect: { url: "https://autre.test/trou" } }, condition: { urlFilter: "/rien-" + id, resourceTypes: ["xmlhttprequest"] } });
  let lus = 0;
  Object.defineProperty(Array.prototype, "0", { get() { lus++; return regle(9); }, configurable: true });
  const trous = [];
  trous[1] = { id: 8, priority: 1, action: { type: "block" }, condition: { urlFilter: "/rien-8", resourceTypes: ["xmlhttprequest"] } };
  let r;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: trous });
    r = { acceptee: true };
  } catch (e) {
    r = { erreur: String(e && e.message) };
  }
  delete Array.prototype[0];
  r.lus = lus;
  r.regles = (await chrome.declarativeNetRequest.getDynamicRules()).map((x) => x.action.type);
  document.title = JSON.stringify(r);
})();
`,
  "cadre.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="cadre.js"></script></body></html>',
  "cadre.js": `(async () => {
 try {
  const sonderNu = async (w, nom) => {
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
  // Firefox: a frame that is cross-origin to the page (srcdoc) is out of its reach.
  const sonder = async (w, nom) => { try { return await sonderNu(w, nom); } catch (e) { if (e && e.name === "SecurityError") return { inaccessible: true }; throw e; } };
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
  // Firefox: the srcdoc frame is cross-origin to the page, its own frame out of reach.
  try {
    window[2].document.body.appendChild(window[2].document.createElement("iframe"));
    vu.petit = await sonder(window[2][0], "petit");
  } catch (e) {
    if (!e || e.name !== "SecurityError") throw e;
    vu.petit = { inaccessible: true };
  }
  const doc = document.createElement("iframe");
  doc.srcdoc = "<p>x</p>";
  document.body.appendChild(doc);
  await new Promise((ok) => doc.addEventListener("load", ok, { once: true }));
  vu.srcdoc = await sonder(window[3], "srcdoc");
  // contentWindow masqué sur l'élément : le cadre n'est atteint que par window[4], lu dans la même tâche.
  const masque = document.createElement("iframe");
  Object.defineProperty(masque, "contentWindow", { get: () => null });
  Object.defineProperty(masque, "contentDocument", { get: () => null });
  document.body.appendChild(masque);
  vu.masqueTot = typeof window[4].RTCPeerConnection;
  vu.masque = await sonder(window[4], "masque");
  // Racine fantôme déclarative (setHTMLUnsafe), que attachShadow ne voit jamais.
  const declare = document.body.appendChild(document.createElement("div"));
  declare.setHTMLUnsafe('<div><template shadowrootmode="open"><iframe></iframe></template></div>');
  const dansDeclare = declare.firstElementChild.shadowRoot.querySelector("iframe");
  vu.declareTot = typeof dansDeclare.contentWindow.RTCPeerConnection;
  vu.declare = await sonder(dansDeclare.contentWindow, "declare");
  // Même tâche, accès indexé seulement : racine déclarative (setHTMLUnsafe), cadre en clair par setHTMLUnsafe et par
  // innerHTML. Puis toutes les fenêtres filles.
  const avantDeclare = window.length;
  document.body.appendChild(document.createElement("div")).setHTMLUnsafe('<div><template shadowrootmode="open"><iframe></iframe></template></div><iframe></iframe>');
  vu.declareLongueur = window.length - avantDeclare;
  vu.declareIndexes = [];
  for (let i = avantDeclare; i < window.length; i++) vu.declareIndexes.push(typeof window[i].RTCPeerConnection);
  const avantInterieur = window.length;
  document.body.appendChild(document.createElement("div")).innerHTML = "<iframe></iframe>";
  vu.interieur = window.length > avantInterieur ? typeof window[avantInterieur].RTCPeerConnection : "absent";
  // Par son nom : window.open("", nom) rend un cadre existant sans ouvrir de fenêtre, même dans une racine fermée.
  document.body.appendChild(document.createElement("div")).setHTMLUnsafe('<div><template shadowrootmode="closed"><iframe name="nomme-ombre"></iframe></template></div><iframe name="nomme-clair"></iframe>');
  for (const nom of ["nomme-ombre", "nomme-clair"]) {
    let f = null;
    try { f = window.open("", nom); } catch (e) { f = null; }
    let rtc = "absent";
    try { rtc = f ? typeof f.RTCPeerConnection : "absent"; } catch (e) { rtc = "inaccessible"; }
    vu[nom] = rtc;
  }
  // Par son nom, sans window.open : document.open(url, nom, options) (forme à trois arguments), l'accès nommé
  // (window[nom], frames[nom]). Chaque cadre nommé est neuf, dans une racine déclarative fermée.
  const parNom = (nom, prendre) => {
    document.body.appendChild(document.createElement("div")).setHTMLUnsafe('<div><template shadowrootmode="closed"><iframe name="' + nom + '"></iframe></template></div>');
    let f = null;
    try { f = prendre(nom); } catch (e) { f = null; }
    try { return f ? typeof f.RTCPeerConnection : "absent"; } catch (e) { return "inaccessible"; }
  };
  vu["docOpen-ombre"] = parNom("doc-ouvre-ombre", (nom) => document.open("", nom, ""));
  vu["nomme-index"] = parNom("nomme-index", (nom) => window[nom]);
  vu["nomme-frames"] = parNom("nomme-frames", (nom) => window.frames[nom]);
  vu.docOpenDeux = (() => { const d = document.implementation.createHTMLDocument(""); try { return d.open("text/html", "") === d ? "document" : "autre"; } catch (e) { return "erreur"; } })();
  vu.tousIndexes = [];
  // Firefox: a cross-origin (srcdoc) frame is « inaccessible ».
  for (let i = 0; i < window.length; i++) { try { vu.tousIndexes.push(typeof window[i].RTCPeerConnection); } catch (e) { vu.tousIndexes.push("inaccessible"); } }
  vu.nombre = window.length;
  vu.frames = typeof window[0];
  vu.regles = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.action.type);
  document.title = JSON.stringify(vu);
 } catch (e) { document.title = "erreur " + e.stack; }
})();
`,
  "ecrit.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="ecrit.js"></script></body></html>',
  "ecrit.js": `const vu = {};
const avant = window.length;
document.write('<div id="hote-ecrit"><template shadowrootmode="open"><iframe></iframe></template></div><iframe></iframe>');
vu.longueur = window.length - avant;
vu.indexes = [];
for (let i = 0; i < window.length; i++) vu.indexes.push(typeof window[i].RTCPeerConnection);
const hote = document.getElementById("hote-ecrit");
vu.ombre = hote && hote.shadowRoot ? "ouverte" : "absente";
document.title = JSON.stringify(vu);
`,
  "blanc.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="blanc.js"></script></body></html>',
  "blanc.js": `(async () => {
  const w = document.body.appendChild(document.createElement("iframe")).contentWindow;
  const vu = {};
  try { await w.chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [6], addRules: [{ id: 6, priority: 1, action: { type: "redirect", redirect: { url: "https://autre.test/fuite-blanc" } }, condition: { urlFilter: "/rien-blanc", resourceTypes: ["xmlhttprequest"] } }] }); vu.dnr = "acceptee"; } catch (e) { vu.dnr = "refusee"; }
  try { new w.RTCPeerConnection(); vu.rtc = "creee"; } catch (e) { vu.rtc = "refusee"; }
  for (const h of ["hote.test", "autre.test"]) { try { vu["ouvre-" + h] = String(w.open("https://" + h + "/cadre-ouvre")); } catch (e) { vu["ouvre-" + h] = "erreur"; } }
  // A srcdoc frame (cross-origin to the page in Firefox) running a script of the extension: what it gets, by message.
  const recu = new Promise((ok) => { addEventListener("message", (e) => ok(e.data), { once: true }); setTimeout(() => ok("aucun"), 2000); });
  const s = document.createElement("iframe");
  s.srcdoc = '<script src="srcdoc.js"></' + 'script>';
  document.body.appendChild(s);
  vu.srcdoc = await recu;
  // One of its own pages in a frame: Firefox may reuse the initial about:blank window for it.
  const propre = document.createElement("iframe");
  propre.src = "ordre.html?rien";
  document.body.appendChild(propre);
  await new Promise((ok) => propre.addEventListener("load", ok, { once: true }));
  await new Promise((ok) => setTimeout(ok, 500));
  vu.propre = { titre: propre.contentDocument.title, chrome: typeof propre.contentWindow.chrome, webaios: typeof propre.contentWindow.__webaios };
  vu.regles = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.action.type);
  document.title = JSON.stringify(vu);
})().catch((e) => (document.title = "erreur " + e));
`,
  "srcdoc.js": `(async () => {
  const vu = { chrome: typeof chrome, webaios: typeof __webaios, rtc: typeof RTCPeerConnection };
  try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [5], addRules: [{ id: 5, priority: 1, action: { type: "redirect", redirect: { url: "https://autre.test/fuite-srcdoc" } }, condition: { urlFilter: "/rien-srcdoc", resourceTypes: ["xmlhttprequest"] } }] }); vu.dnr = "acceptee"; } catch (e) { vu.dnr = "refusee"; }
  try { vu.ouvre = String(open("https://autre.test/srcdoc-ouvre")); } catch (e) { vu.ouvre = "erreur"; }
  parent.postMessage(vu, "*");
})();
`,
  "fenetres.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="fenetres.js"></script></body></html>',
  "fenetres.js": `const vu = {};
const essai = (nom, f) => { try { const w = f(); vu[nom] = w === null || w === undefined ? "null" : typeof w; } catch (e) { vu[nom] = "erreur"; } };
essai("docOpen", () => document.open("https://hote.test/doc-open", "_blank", ""));
essai("docOpenBlank", () => document.open("about:blank", "_blank", ""));
essai("fenetre", () => window.open("https://hote.test/fenetre-options", "x", "width=300,height=300"));
const a = document.createElement("a");
a.href = "https://hote.test/lien-blank";
a.target = "_blank";
document.body.appendChild(a);
a.click();
document.title = JSON.stringify(vu);
`,
  "capture.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="capture.js"></script></body></html>',
  "capture.js": `(async () => {
  const vu = {};
  const essai = async (nom, f) => { try { const r = await f(); vu[nom] = { ok: typeof r === "string" ? r.slice(0, 22) : r ?? null }; } catch (e) { vu[nom] = { erreur: String(e && e.message) }; } };
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  vu.url = t && t.url;
  await essai("visible", () => chrome.tabs.captureVisibleTab());
  await essai("onglet", () => chrome.tabs.captureTab(t.id));
  await essai("langue", () => chrome.tabs.detectLanguage(t.id));
  document.title = JSON.stringify(vu);
})().catch((e) => (document.title = "erreur " + e));
`,
  "ordre.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="ordre.js"></script></body></html>',
  "ordre.js": `chrome.runtime.sendMessage(location.search.slice(1)).then((r) => (document.title = String(r)), (e) => (document.title = "erreur " + e.message));
`,
};

const NETWORK_GRANT = {
  permissions: ["cookies", "declarativeNetRequest", "storage", "tabs"],
  hosts: ["https://hote.test/*"],
  network: ["accorde.test"],
  allSites: false,
  allSitesScripts: false,
  scripts: false,
};


/** A form the page fills itself (as a password manager would). */
const FORM_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>formulaire</title></head><body>
<form id="f" action="/envoi"><input type="text" id="texte" name="texte"><input type="password" id="mdp" name="mdp"></form>
<script>document.getElementById("texte").value = "visible"; document.getElementById("mdp").value = "secret";
// Comme React : la valeur recopiée dans l'attribut \`value\`.
document.getElementById("texte").setAttribute("value", "visible"); document.getElementById("mdp").setAttribute("value", "secret");</script>
</body></html>`;
/** A page whose image delays the load end, so the invisible read stays open a few seconds. */
const READ_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>lecture</title></head><body><p>Texte lu</p><img src="/lent.png"></body></html>`;

/**
 * The guard extension: a content script in two files on hote.test (one
 * scope), which reads the fields, listens to the keyboard, sends to hote.test, accorde.test (`reseau`) and autre.test,
 * then marks `<html data-agent-vu>` and appends « AGENT-VU » to the text; what it saw is in `data-agent` (JSON). Its
 * background runs the orders of `ordre.html?<order>` (executeScript).
 */
const EXTENSION_GUARD = {
  "manifest.json": {
    manifest_version: 3,
    name: "Garde de l'agent",
    version: "1.0.0",
    permissions: ["scripting", "tabs"],
    host_permissions: ["https://hote.test/*"],
    background: { service_worker: "fond.js" },
    content_scripts: [
      { matches: ["https://hote.test/*"], js: ["outils.js", "contenu.js"], run_at: "document_end" },
      { matches: ["https://hote.test/*"], js: ["evade.js"], css: ["fuite.css"], run_at: "document_start" },
    ],
  },
  "webaios.json": { network: ["accorde.test"] },
  // Written to break out of a textual wrapper (`});` … `(() => {`): runs nowhere, not even before the background's answer.
  "evade.js": '});\ndocument.documentElement.setAttribute("data-evade", "1");\nglobalThis.__webaiosApres(() => {\n',
  // An agent stylesheet that loads an image from autre.test: never requested from an invisible read.
  "fuite.css": "html { background-image: url(https://autre.test/cs-css); }\n",
  // Without a lexical declaration: rerun in the same world, it would count every pass (contenu.js, for its part, would throw on its `const`).
  "outils.js": `document.documentElement.setAttribute("data-agent-compte", String(Number(document.documentElement.getAttribute("data-agent-compte") || 0) + 1));
function noter(cle, valeur) {
  const r = JSON.parse(document.documentElement.getAttribute("data-agent") || "{}");
  r[cle] = valeur;
  document.documentElement.setAttribute("data-agent", JSON.stringify(r));
}
`,
  "contenu.js": `const mdp = document.getElementById("mdp");
const champ = document.getElementById("texte");
if (mdp) {
  noter("mdp", mdp.value);
  noter("texte", champ.value);
  const fd = new FormData(document.getElementById("f"));
  noter("formMdp", fd.get("mdp"));
  noter("formTexte", fd.get("texte"));
  console.log("agent:" + JSON.stringify({ mdp: mdp.value, texte: champ.value }));
  const touches = [];
  const voir = (x) => { touches.push(x); noter("touches", touches); };
  document.addEventListener("keydown", (e) => voir(e.target.id + ":" + e.key), true);
  window.addEventListener("keypress", (e) => voir("keypress:" + e.target.id));
  mdp.onkeyup = (e) => voir("onkeyup:" + e.key);
  champ.onkeyup = (e) => voir("onkeyup-texte:" + e.key);
  for (const el of [champ, mdp]) el.addEventListener("input", { handleEvent: (e) => voir("input:" + e.target.id) });
  noter("ecoute", true);
  const essais = {};
  const essayer = (nom, f) => {
    try {
      const r = f();
      essais[nom] = "parti";
      if (r && typeof r.then === "function") r.then(() => {}, (e) => { essais[nom] = String(e && e.message); noter("reseau", essais); });
    } catch (e) {
      essais[nom] = String(e && e.message);
    }
  };
  for (const h of ["hote.test", "accorde.test", "autre.test"]) {
    essayer("fetch-" + h, () => fetch("https://" + h + "/cs-fetch"));
    essayer("image-" + h, () => { new Image().src = "https://" + h + "/cs-image"; });
  }
  essayer("xhr-autre", () => { const x = new XMLHttpRequest(); x.open("GET", "https://autre.test/cs-xhr"); x.send(); });
  essayer("beacon-autre", () => { if (!navigator.sendBeacon("https://autre.test/cs-beacon", "x")) throw new Error("refusé"); });
  essayer("ws-autre", () => new WebSocket("wss://autre.test/cs-ws"));
  essayer("source-autre", () => new EventSource("https://autre.test/cs-source"));
  essayer("attribut-autre", () => document.createElement("img").setAttribute("src", "https://autre.test/cs-attribut"));
  essayer("lien-autre", () => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "https://autre.test/cs-lien"; document.head.appendChild(l); });
  essayer("ouvrir-autre", () => { if (window.open("https://autre.test/cs-ouvre") === null) throw new Error("null"); });
  noter("reseau", essais);
}
document.documentElement.setAttribute("data-agent-vu", "1");
document.body.append(" AGENT-VU ");
`,
  "vide.html": '<!doctype html><html><head><meta charset="utf-8"><title>vide</title></head><body>page de l\'agent</body></html>',
  "injecte.js": `document.getElementById("mdp").value + "|" + document.getElementById("texte").value;\n`,
  "fond.js": `// Il tente de répondre « onglet » à la garde de page à sa place : le garde du fond ne le lui laisse pas voir.
chrome.runtime.onMessage.addListener((m, _e, repondre) => {
  if (m && m.webaios === "context") repondre({ tab: true });
});
// Et par la méthode du prototype de l'événement, prise à part.
let porteur = chrome.runtime.onMessage;
while (porteur && !Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(porteur) || {}, "addListener")) porteur = Object.getPrototypeOf(porteur);
const ajouterNatif = porteur ? Object.getPrototypeOf(porteur).addListener : chrome.runtime.onMessage.addListener;
ajouterNatif.call(chrome.runtime.onMessage, (m, _e, repondre) => {
  if (m && m.webaios === "context") repondre({ tab: true });
});
// Où sont les méthodes de l'événement, et sont-elles celles du garde (non configurables) ?
const porteurs = [];
for (let o = chrome.runtime.onMessage; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
  const d = Object.getOwnPropertyDescriptor(o, "addListener");
  porteurs.push(d ? (d.configurable ? "configurable" : "figee") : "-");
}
chrome.runtime.onMessage.addListener((m, _e, repondre) => {
  if (typeof m !== "string") return;
  (async () => {
    if (m.startsWith("executer:")) {
      const tabId = Number(m.slice("executer:".length));
      return chrome.scripting.executeScript({ target: { tabId }, func: () => document.documentElement.getAttribute("data-agent-vu") })
        .then((r) => "ok " + JSON.stringify(r.map((x) => x.result)), (e) => "erreur " + e.message);
    }
    if (m === "executer-onglet") {
      const [onglet] = await chrome.tabs.query({ url: "https://hote.test/formulaire*" });
      const fichiers = await chrome.scripting.executeScript({ target: { tabId: onglet.id }, files: ["injecte.js"] });
      const fonction = await chrome.scripting.executeScript({ target: { tabId: onglet.id }, func: () => document.getElementById("mdp").value + "|" + document.getElementById("texte").value });
      return JSON.stringify({ fichiers: fichiers.map((x) => x.result), fonction: fonction.map((x) => x.result), documentId: typeof fonction[0].documentId });
    }
    if (m === "attributs-onglet") {
      const [onglet] = await chrome.tabs.query({ url: "https://hote.test/formulaire*" });
      const r = await chrome.scripting.executeScript({ target: { tabId: onglet.id }, func: () => {
        const lire = (el) => {
          const n = el.getAttributeNode("value");
          return [el.getAttribute("value"), el.getAttributeNS(null, "value"), n && n.value, n && n.nodeValue, n && n.textContent,
            el.attributes.value && el.attributes.value.value, el.attributes.getNamedItem("value").nodeValue,
            Array.from(el.attributes).map((a) => a.value + "/" + a.nodeValue + "/" + a.textContent).join(","), el.defaultValue];
        };
        return JSON.stringify({ mdp: lire(document.getElementById("mdp")), texte: lire(document.getElementById("texte")) });
      } });
      return r[0].result;
    }
    if (m === "porteurs") return JSON.stringify({ porteurs, priseAPartEstCelleDuGarde: ajouterNatif === chrome.runtime.onMessage.addListener });
    return "inconnu";
  })().then(repondre, (e) => repondre("erreur " + (e && e.message)));
  return true;
});
`,
  "ordre.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="ordre.js"></script></body></html>',
  "ordre.js": `chrome.runtime.sendMessage(location.search.slice(1)).then((r) => (document.title = String(r)), (e) => (document.title = "erreur " + e.message));
`,
};
const GRANT_KEPT = {
  permissions: ["scripting", "tabs"],
  hosts: ["https://hote.test/*"],
  network: ["accorde.test"],
  allSites: false,
  allSitesScripts: false,
  scripts: true,
};

const dirs: string[] = [];
const opened: LaunchedWebAiOs[] = [];
afterEach(async () => {
  for (const w of opened.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The « réseau » extension granted, WebAiOs launched behind the recording proxy; resolves once it is installed and running. */
const launchNetwork = () => launchAgent("reseau", EXTENSION_NETWORK, NETWORK_GRANT);

/** Agent extension `nom` granted, WebAiOs launched behind the recording proxy; resolves once it is installed and running. */
async function launchAgent(name: string, files: Record<string, string | object>, access: object): Promise<LaunchedWebAiOs & { uuid: string; dataDir: string }> {
  const id = `${name}@agent.webaios`;
  const f = { dataDir: mkdtempSync(path.join(os.tmpdir(), "webaios-data-")), profile: mkdtempSync(path.join(os.tmpdir(), "webaios-firefox-")) };
  dirs.push(f.dataDir, f.profile);
  writeAgentExtension(path.join(f.dataDir, "workspace"), name, files);
  grant(f.dataDir, name, access);
  const prefs = {
    "network.proxy.type": 1,
    "network.proxy.http": "127.0.0.1",
    "network.proxy.http_port": proxy.port,
    "network.proxy.ssl": "127.0.0.1",
    "network.proxy.ssl_port": proxy.port,
  };
  const w = await launchWithAmo({ ...f, prefs });
  opened.push(w);
  // The proxy's self-signed certificate: accepted for this run.
  await w.marionette.execute(
    'Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).setDisableAllSecurityChecksAndLetAttackersInterceptMyData(true);',
  );
  const uuid = await waitFor<string | null>(
    w.marionette,
    `return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const a = await AddonManager.getAddonByID(${JSON.stringify(id)});
      return a?.isActive ? WebExtensionPolicy.getByID(${JSON.stringify(id)})?.mozExtensionHostname ?? null : null;
    })();`,
    (v) => !!v,
    30_000,
  );
  return { ...w, uuid: uuid!, dataDir: f.dataDir };
}

/** The background's startup tries are over (its block rule set): the results it kept, read from its page. */
const backgroundResults = async (w: LaunchedWebAiOs & { uuid: string }) =>
  JSON.parse((await extensionPage(w.marionette, `moz-extension://${w.uuid}/results.html`, 0)).title) as Record<string, unknown>;

/**
 * Opens a page of the extension in a tab, waits until its title leaves « attente », then `ms` more; returns its title
 * and address, then closes it.
 */
async function extensionPage(m: Marionette, url: string, ms = 1500): Promise<{ title: string; url: string }> {
  await m.execute("window.extensionTab = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });", [url]);
  await waitFor(m, "return window.extensionTab.linkedBrowser.contentTitle", (t: string) => !!t && t !== "attente", 20_000);
  await sleep(ms);
  const r = await m.execute<{ title: string; url: string }>(
    "const b = window.extensionTab.linkedBrowser; return { titre: b.contentTitle, url: b.currentURI.spec };",
  );
  await m.execute("gBrowser.removeTab(window.extensionTab);");
  return r;
}

/** The expectations on cadre.js's report; a frame out of the page's reach (cross-origin) passes. */
function checkFrames(title: string): void {
  const seen = JSON.parse(title) as Record<string, any>;
  for (const frame of ["blank", "index", "ombre", "srcdocTot", "petit", "srcdoc", "masque", "declare"]) {
    if (seen[frame]?.inaccessible) continue;
    expect(seen[frame].protocole, frame).toBe("about:");
    expect(seen[frame].rtc, frame).toBe("undefined");
    expect(seen[frame].rtcEssai, frame).not.toBe("creee");
    expect(seen[frame].tabs, frame).toBe("undefined");
    expect(seen[frame].dnr, frame).not.toBe("acceptee");
  }
  expect(seen.masqueTot).toBe("undefined");
  expect(seen.declareLongueur).toBeGreaterThan(0);
  expect(seen.declareIndexes.every((t: string) => t === "undefined")).toBe(true);
  expect(seen.interieur).toBe("undefined");
  for (const name of ["nomme-ombre", "nomme-clair", "docOpen-ombre"]) expect(["undefined", "absent"], name).toContain(seen[name]);
  for (const name of ["nomme-index", "nomme-frames"]) expect(["undefined", "absent"], name).toContain(seen[name]);
  expect(seen.tousIndexes.length).toBe(seen.nombre);
  expect(seen.tousIndexes.every((t: string) => t === "undefined" || t === "inaccessible")).toBe(true);
  expect(seen.declareTot).toBe("undefined");
  // No redirect set: only the block rule of the start.
  expect(seen.regles).toEqual(["block"]);
}

const order = async (w: LaunchedWebAiOs & { uuid: string }, what: string) => (await extensionPage(w.marionette, `moz-extension://${w.uuid}/ordre.html?${what}`, 0)).title;

describe("agent extensions: network guard", () => {
  it("the background cannot send to a domain not granted (fetch, WebSocket); to the granted one, yes", async () => {
    await launchNetwork();
    await until(() => hitsTo("accorde.test", "/sw-fetch").length > 0);
    await until(() => hitsTo("accorde.test", "/sw-ws").length > 0);
    await sleep(1000);
    expect(hitsTo("autre.test")).toEqual([]);
  });

  it("nor its pages (fetch, sendBeacon, WebSocket, navigation, window.open); RTCPeerConnection is absent from them", async () => {
    const w = await launchNetwork();
    const page = await extensionPage(w.marionette, `moz-extension://${w.uuid}/page.html`);
    expect(JSON.parse(page.title)).toEqual({ rtc: "undefined", rtcWebkit: "undefined", channel: "undefined", opening: "null" });
    // The navigation to autre.test was refused: the page stayed its own.
    expect(page.url).toBe(`moz-extension://${w.uuid}/page.html`);
    await until(() => hitsTo("accorde.test", "/page-fetch").length > 0);
    await until(() => hitsTo("accorde.test", "/page-beacon").length > 0);
    await until(() => hitsTo("accorde.test", "/page-ws").length > 0);
    expect(hitsTo("autre.test")).toEqual([]);
    expect(hitsTo("hote.test", "/page-ouvre")).toEqual([]);
  });

  it("tabs.create to a domain not granted is refused, to a site of its hosts opened; a DNR redirect is refused, a block accepted", async () => {
    const w = await launchNetwork();
    const r = await backgroundResults(w);
    expect(r).toMatchObject({
      tabDenied: { error: "URL refusée par WebAiOs" },
      tabData: { error: "URL refusée par WebAiOs" },
      tabAllowed: { ok: "number" },
      windowRefused: { error: "URL refusée par WebAiOs" },
      dnrRedirect: { error: "Règle DNR refusée par WebAiOs (redirect)" },
      dnrHeaders: { error: "Règle DNR refusée par WebAiOs (modifyHeaders)" },
      dnrBlock: { ok: "acceptee" },
      dnrRules: { ok: ["block"] },
      rtc: { ok: "undefined" },
    });
    // Firefox refuses a permission not in optional_permissions (which the copy refuses anyway).
    expect(r.permissionsDownloads).not.toEqual({ ok: true });
    await until(() => hitsTo("hote.test", "/onglet-permis").length > 0);
    expect(hitsTo("autre.test")).toEqual([]);
  });

  // Another add-on: an AMO-style one installed temporarily, blocking by a static DNR ruleset and
  // fetching where it likes.
  it("with an agent extension running, another add-on still blocks (DNR) and sends where it likes; pages load", async () => {
    const w = await launchNetwork();
    const m = w.marionette;
    const other = "bloqueur-statique@webaios.test";
    await installAddon(m, {
      id: other,
      manifest: {
        manifest_version: 3,
        name: "Bloqueur statique",
        version: "1.0",
        browser_specific_settings: { gecko: { id: other } },
        permissions: ["declarativeNetRequest"],
        host_permissions: ["https://autre.test/*"],
        background: { scripts: ["fond.js"] },
        declarative_net_request: { rule_resources: [{ id: "regles", enabled: true, path: "regles.json" }] },
      },
      files: {
        "fond.js": 'fetch("https://autre.test/store-fetch").catch(() => {});',
        "regles.json": JSON.stringify([{ id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "/pub.js", resourceTypes: ["script"] } }]),
      },
    });
    await until(() => hitsTo("autre.test", "/store-fetch").length > 0);
    await openTab(m, "https://autre.test/onglet-site");
    await until(() => hitsTo("autre.test", "/onglet-site").length > 0);
    await openTab(m, `${server.url}/pub.html?avec-agent`);
    const deadline = Date.now() + 10_000;
    while ((await m.execute<string>("return gBrowser.selectedBrowser.contentTitle")) !== "pub bloquée") {
      expect(Date.now()).toBeLessThan(deadline);
      await m.execute("gBrowser.selectedBrowser.reload()");
      await sleep(700);
    }
    // The agent's extension sent nothing outside its grant meanwhile.
    expect(hitsTo("autre.test", "/sw-fetch")).toEqual([]);
  });

  it("chrome.action.setPopup to an absolute address then openPopup (and a click on its button): nothing is loaded", async () => {
    const w = await launchNetwork();
    const m = w.marionette;
    // An active tab in the window: the popup has somewhere to anchor.
    await openTab(m, "https://hote.test/ancre");
    await until(() => hitsTo("hote.test", "/ancre").length > 0);
    // Firefox may refuse an absolute popup address itself.
    expect(await order(w, "popup-fuite")).toMatch(/^(fait|Access denied for URL https:\/\/autre\.test\/popup-fuite)$/);
    await waitFor(m, `return !!window.webaiosWindow.addons.buttons().find((b) => b.id === ${JSON.stringify(ID)})?.enabled`, (v) => v === true);
    await m.execute(`window.webaiosWindow.addons.click(arguments[0], { x: 0, y: 0, width: 24, height: 24 });`, [ID]);
    await sleep(1500);
    expect(hitsTo("autre.test")).toEqual([]);
  });

  // An agent
  // extension's holey list is refused without the prototype's getter being read. The agent half only.
  it("updateDynamicRules with a holey list: the agent's guard refuses it", async () => {
    const w = await launchNetwork();
    await backgroundResults(w);
    const page = await extensionPage(w.marionette, `moz-extension://${w.uuid}/tableaux.html`, 0);
    expect(JSON.parse(page.title)).toEqual({ error: "Règle DNR refusée par WebAiOs (tableau à trous)", read: 0, rules: ["block"] });
  });

  it("dns-prefetch, preconnect, prefetch… links of an agent page to a domain not granted contact nothing", async () => {
    const w = await launchNetwork();
    const page = await extensionPage(w.marionette, `moz-extension://${w.uuid}/liens.html`);
    // All set (no refusal from the DOM): it is the network that does not go.
    expect(Object.values(JSON.parse(page.title) as Record<string, string>).every((v) => v === "pose")).toBe(true);
    expect(proxy.hits.filter((c) => c.host.endsWith("autre.test"))).toEqual([]);
  });

  // No clients.openWindow half: a Firefox background page has no `clients` (spike S2).
  it("runtime.setUninstallURL to a domain not granted opens nothing, uninstall included; no clients in the background", async () => {
    const w = await launchNetwork();
    const m = w.marionette;
    expect(await order(w, "clients-type")).toBe("undefined");
    expect(await order(w, "desinstallation")).toMatch(/^(posee|erreur .*)$/);
    await m.command("Addon:Uninstall", { id: ID });
    await sleep(1500);
    expect(await m.execute<number>("return gBrowser.tabs.filter((t) => t.linkedBrowser.currentURI.spec.includes('autre.test')).length")).toBe(0);
    expect(hitsTo("autre.test")).toEqual([]);
  });

  it("document.open with an address, a window with features, <a target=_blank>: an agent page opens nothing", async () => {
    const w = await launchNetwork();
    const m = w.marionette;
    await backgroundResults(w);
    const before = await m.execute<number>("return gBrowser.tabs.length");
    const page = await extensionPage(m, `moz-extension://${w.uuid}/fenetres.html`);
    // The CSP sandbox (no allow-popups) makes document.open(url, name, features) throw; either way no window.
    const seen = JSON.parse(page.title);
    for (const name of ["docOpen", "docOpenBlank", "fenetre"]) expect(["null", "erreur"]).toContain(seen[name]);
    expect(await m.execute<number>("return gBrowser.tabs.length")).toBe(before);
    expect(await m.execute<number>("return [...Services.wm.getEnumerator('navigator:browser')].length")).toBe(1);
    for (const path of ["/doc-open", "/fenetre-options", "/lien-blank"]) expect(hitsTo("hote.test", path)).toEqual([]);
  });

  // Firefox has rights the guard must refuse too (review probe): refused at the copy, before any card or signature.
  it("an agent extension asking identity, notifications, dns or find is refused at the copy: nothing signed, nothing installed", async () => {
    const f = { dataDir: mkdtempSync(path.join(os.tmpdir(), "webaios-data-")), profile: mkdtempSync(path.join(os.tmpdir(), "webaios-firefox-")) };
    dirs.push(f.dataDir, f.profile);
    const perms = ["cookies", "declarativeNetRequest", "storage", "tabs", "identity", "notifications", "dns", "find"];
    writeAgentExtension(path.join(f.dataDir, "workspace"), "reseau", { ...EXTENSION_NETWORK, "manifest.json": { ...EXTENSION_NETWORK["manifest.json"], permissions: perms } });
    grant(f.dataDir, "reseau", { ...NETWORK_GRANT, permissions: perms });
    const w = await launchWithAmo(f);
    opened.push(w);
    await w.marionette.execute(`return (async () => { await (await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready).agentExtensions.ready; })();`);
    expect(w.amo.sends).toEqual([]);
    expect(await agentAddons(w.marionette)).toEqual([]);
    expect(proxy.hits.filter((h) => h.host.endsWith("autre.test"))).toEqual([]);
  });

  // In a tab of the extension (its popup: the next test). Firefox: a srcdoc frame is cross-origin to the
  // page (out of its reach); the about:blank ones are reached by the extension actor, which takes the extension API
  // and WebRTC out of them.
  it("in its page, an about:blank, srcdoc, nested or shadow-root frame has neither RTCPeerConnection nor a way to set a DNR redirect", async () => {
    const w = await launchNetwork();
    await backgroundResults(w);
    const page = await extensionPage(w.marionette, `moz-extension://${w.uuid}/cadre.html`, 0);
    console.log(`[mesure] cadres : ${page.title}`);
    checkFrames(page.title);
  });

  // Firefox grants activeTab to an MV3 extension on a click of its button, of its menu item or on its command, even
  // without the right; captureVisibleTab, captureTab and detectLanguage are refused for every agent page.
  it("after a click on its button, the popup cannot capture nor read the language of a tab outside its hosts", async () => {
    const w = await launchNetwork();
    const m = w.marionette;
    await backgroundResults(w);
    expect(await order(w, "popup-capture")).toBe("fait");
    await openTab(m, "https://autre.test/lisible");
    await until(() => hitsTo("autre.test", "/lisible").length > 0);
    await waitFor(m, `return !!window.webaiosWindow.addons.buttons().find((b) => b.id === ${JSON.stringify(ID)})?.enabled`, (v) => v === true);
    await m.execute(`window.webaiosWindow.addons.click(arguments[0], { x: 0, y: 0, width: 24, height: 24 });`, [ID]);
    const title = await waitFor<string | null>(
      m,
      `const b = [...document.querySelectorAll("browser")].find((b) => b.currentURI?.spec.endsWith("/capture.html"));
       return b ? b.contentTitle : null;`,
      (t) => !!t && t !== "attente",
      15_000,
    );
    const seen = JSON.parse(title!);
    expect(seen.url).toBe("https://autre.test/lisible");
    for (const name of ["visible", "onglet", "langue"]) expect(seen[name], name).toHaveProperty("erreur");
  });

  it("in its popup too (setPopup cadre.html, then a click on its button)", async () => {
    const w = await launchNetwork();
    const m = w.marionette;
    await backgroundResults(w);
    await openTab(m, "https://hote.test/ancre-cadres");
    await until(() => hitsTo("hote.test", "/ancre-cadres").length > 0);
    expect(await order(w, "popup-cadres")).toBe("fait");
    await waitFor(m, `return !!window.webaiosWindow.addons.buttons().find((b) => b.id === ${JSON.stringify(ID)})?.enabled`, (v) => v === true);
    await m.execute(`window.webaiosWindow.addons.click(arguments[0], { x: 0, y: 0, width: 24, height: 24 });`, [ID]);
    // The popup's browser (webext-browsers) on cadre.html: its title is the report.
    const title = await waitFor<string | null>(
      m,
      `const b = [...document.querySelectorAll("browser")].find((b) => b.currentURI?.spec.endsWith("/cadre.html"));
       return b ? b.contentTitle : null;`,
      (t) => !!t && t !== "attente",
      15_000,
    );
    checkFrames(title!);
  });

  it("document.write of a frame while loading (in the clear and in a declarative shadow root): no child window has RTCPeerConnection in the same task", async () => {
    const w = await launchNetwork();
    const page = await extensionPage(w.marionette, `moz-extension://${w.uuid}/ecrit.html`, 0);
    console.log(`[mesure] document.write : ${page.title}`);
    const seen = JSON.parse(page.title) as { length: number; indexes: string[]; shadow: string };
    expect(seen.shadow).toBe("ouverte");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.indexes.every((t) => t === "undefined")).toBe(true);
  });

  it("from an about:blank frame of its page: a DNR redirect, RTCPeerConnection and window.open are refused", async () => {
    const w = await launchNetwork();
    await backgroundResults(w);
    const page = await extensionPage(w.marionette, `moz-extension://${w.uuid}/blanc.html`);
    console.log(`[mesure] about:blank, srcdoc : ${page.title}`);
    expect(JSON.parse(page.title)).toMatchObject({ dnr: "refusee", rtc: "refusee", "ouvre-hote.test": "null", "ouvre-autre.test": "null", rules: ["block"] });
    // A srcdoc frame runs none of its scripts (measured « aucun »); if it ever does, it must get nothing either.
    const srcdoc = JSON.parse(page.title).srcdoc;
    if (srcdoc !== "aucun") expect(srcdoc).toMatchObject({ chrome: "undefined", rtc: "undefined", dnr: "refusee", opens: "null" });
    expect(hitsTo("hote.test", "/cadre-ouvre")).toEqual([]);
    expect(hitsTo("autre.test")).toEqual([]);
  });
});

// The agent's content scripts.
describe("agent extensions: content scripts", () => {
  const launchGuard = () => launchAgent("garde", EXTENSION_GUARD, GRANT_KEPT);
  /** What the agent's content script noted in WebAiOs tab `tab` (null: nothing). */
  const seenByAgent = async (m: Marionette, tab: string) => {
    const raw = await inPage<string | null>(m, tab, "return document.documentElement.getAttribute('data-agent')");
    return typeof raw === "string" ? (JSON.parse(raw) as Record<string, any>) : null;
  };
  async function poll<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
    const deadline = Date.now() + ms;
    let v = await f();
    while (!ok(v) && Date.now() < deadline) {
      await sleep(200);
      v = await f();
    }
    return v;
  }

  it("on a page, a filled password field's value is empty for the agent's script, a text field's is not; no password keydown reaches it; executeScript runs after the guard", async () => {
    const w = await launchGuard();
    const m = w.marionette;
    const tab = await openTab(m, "https://hote.test/formulaire");
    expect((await poll(() => seenByAgent(m, tab), (v) => v?.ecoute === true))?.ecoute).toBe(true);
    // The page sees its own value.
    expect(await inPage(m, tab, "return document.getElementById('mdp').value")).toBe("secret");
    expect(await seenByAgent(m, tab)).toMatchObject({ password: "", text: "visible", formPassword: null, formText: "visible" });
    // The keyboard, simulated by the page: what targets the text field arrives, nothing that targets the password.
    await inPage(
      m,
      tab,
      `const ev = (el, type, key) => el.dispatchEvent(type === "input" ? new InputEvent("input", { bubbles: true, data: key }) : new KeyboardEvent(type, { key, bubbles: true }));
       const t = document.getElementById("texte"), p = document.getElementById("mdp");
       ev(t, "keydown", "a"); ev(t, "keypress", "a"); ev(t, "input", "a"); ev(t, "keyup", "a");
       ev(p, "keydown", "b"); ev(p, "keypress", "b"); ev(p, "input", "b"); ev(p, "keyup", "b");`,
    );
    const keys = ["texte:a", "keypress:texte", "input:texte", "onkeyup-texte:a"];
    expect((await poll(() => seenByAgent(m, tab), (v) => v?.touches?.length === 4))?.touches).toEqual(keys);
    await sleep(300);
    expect((await seenByAgent(m, tab))?.touches).toEqual(keys);
    // executeScript from the background: files and function run after the guard.
    const r = await order(w, "executer-onglet");
    console.log(`[mesure] executeScript dans un onglet : ${r}`);
    expect(JSON.parse(r)).toMatchObject({ files: ["|visible"], function: ["|visible"] });
    // I4: the value copied into the attribute (React) is not readable either.
    const a = await order(w, "attributs-onglet");
    const lu = JSON.parse(a) as { password: unknown[]; text: unknown[] };
    expect(a).not.toContain("secret");
    expect(lu.password.slice(0, 7)).toEqual(Array(7).fill(""));
    expect(lu.password[8]).toBe("");
    expect(lu.text.slice(0, 7)).toEqual(Array(7).fill("visible"));
    expect(lu.text[8]).toBe("visible");
  });

  // An agent page kept open in a tab outside the store.
  it("with a page of the agent open, its content script runs only once in a tab", async () => {
    const w = await launchGuard();
    const m = w.marionette;
    await m.execute("window.agentPage = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });", [
      `moz-extension://${w.uuid}/vide.html`,
    ]);
    await waitFor(m, "return window.agentPage.linkedBrowser.contentTitle", (t) => t === "vide");
    const tab = await openTab(m, "https://hote.test/formulaire?compte");
    const count = () => inPage<string | null>(m, tab, "return document.documentElement.getAttribute('data-agent-compte')");
    expect(await poll(count, (v) => v === "1")).toBe("1");
    await sleep(1500);
    expect(await count()).toBe("1");
    expect(await m.execute("return window.agentPage.linkedBrowser.currentURI.spec")).toBe(`moz-extension://${w.uuid}/vide.html`);
  });

  it("fetch and new Image().src to a domain not granted from the content script: nothing reaches the server; to the page's site and to reseau: sent", async () => {
    const w = await launchGuard();
    const m = w.marionette;
    const tab = await openTab(m, "https://hote.test/formulaire?reseau");
    await until(() => hitsTo("hote.test", "/cs-fetch").length > 0);
    await until(() => hitsTo("hote.test", "/cs-image").length > 0);
    await until(() => hitsTo("accorde.test", "/cs-fetch").length > 0);
    await sleep(1500);
    const seen = (await seenByAgent(m, tab))!;
    console.log(`[mesure] réseau du script de contenu : ${JSON.stringify(seen.reseau)}`);
    for (const path of ["/cs-fetch", "/cs-image", "/cs-xhr", "/cs-beacon", "/cs-ws", "/cs-source", "/cs-attribut", "/cs-lien", "/cs-ouvre"])
      expect(hitsTo("autre.test", path), path).toEqual([]);
    expect(seen.reseau).toMatchObject({
      "fetch-autre.test": "URL refusée par WebAiOs",
      "image-autre.test": "URL refusée par WebAiOs",
      "xhr-autre": "URL refusée par WebAiOs",
      "beacon-autre": "refusé",
      "ws-autre": "URL refusée par WebAiOs",
      "source-autre": "URL refusée par WebAiOs",
      "attribut-autre": "URL refusée par WebAiOs",
      "lien-autre": "URL refusée par WebAiOs",
      "ouvrir-autre": "null",
      "fetch-hote.test": "parti",
      "image-hote.test": "parti",
      "fetch-accorde.test": "parti",
    });
  });

  // A widget read with an account is the store's readPage in the profile (spike S4: no content script
  // runs in an invisible read, so it has no tab id).
  it("in an invisible read of the same profile, data-agent-vu is absent and executeScript to it is refused; in a tab of that profile it is present", async () => {
    const w = await launchGuard();
    const m = w.marionette;
    // localAddresses: hote.test only resolves through the test proxy (the read's local guard would refuse it).
    // The read's browser, caught on its request, and the id Firefox's tabTracker gives it.
    await m.execute(`window.readingTabId = null;
      const o = (subject) => {
        const c = subject.QueryInterface(Ci.nsIHttpChannel);
        if (!c.URI.spec.startsWith("https://hote.test/lecture")) return;
        const b = c.loadInfo.browsingContext?.top?.embedderElement;
        if (b) window.readingTabId = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs").ExtensionParent.apiManager.global.tabTracker.getBrowserData(b).tabId;
        Services.obs.removeObserver(o, "http-on-modify-request");
      };
      Services.obs.addObserver(o, "http-on-modify-request");`);
    await m.execute(`window.reading = null;
      ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready
        .then((s) => s.readPage("https://hote.test/lecture", { profile: "default", domains: ["hote.test"], localAddresses: true }))
        .then((p) => (window.reading = { ok: p }), (e) => (window.reading = { err: String(e?.message ?? e) }));`);
    const readingTabId = await waitFor<number | null>(m, "return window.readingTabId", (v) => v !== null);
    // While the read is open (its image is slow): executeScript from the background, then the tabs it may see.
    const orderOf = await order(w, `executer:${readingTabId}`);
    console.log(`[mesure] lecture invisible : tabId ${readingTabId}, executeScript : ${orderOf}`);
    expect(orderOf).toMatch(/^erreur /);
    const read = await waitFor<{ ok?: { text: string }; err?: string } | null>(m, "return window.reading", (v) => v !== null, 30_000);
    expect(read?.err).toBeUndefined();
    expect(read!.ok!.text).toContain("Texte lu");
    expect(read!.ok!.text).not.toContain("AGENT-VU");
    expect(hitsTo("autre.test", "/cs-css")).toEqual([]);
    // Witness: in a tab of the same profile, the agent's script runs, its sheet is set, the escape file still does not run.
    const tab = await openTab(m, "https://hote.test/lecture?onglet");
    expect(await poll(() => inPage<string | null>(m, tab, "return document.documentElement.getAttribute('data-agent-vu')"), (v) => v === "1")).toBe("1");
    // Its sheet is set; Firefox loads its image with the extension's principal, so the network guard cancels it:
    // stricter, and no read of the sheet's request.
    const sheet = () => inPage<string>(m, tab, "return getComputedStyle(document.documentElement).backgroundImage");
    expect(await poll(sheet, (v) => v.includes("cs-css"))).toContain("https://autre.test/cs-css");
    expect(await inPage(m, tab, "return document.documentElement.getAttribute('data-evade')")).toBeNull();
  });

  // Firefox only: a content script's global is a sandbox, its `window` the page's window through an Xray, which has the
  // page's own open, fetch, XMLHttpRequest, WebSocket and EventSource.
  it("through window (the page's window in Firefox), the content script's open, fetch, XMLHttpRequest, WebSocket and EventSource are guarded too", async () => {
    const w = await launchAgent(
      "sonde",
      {
        "manifest.json": { manifest_version: 3, name: "Sonde", version: "1.0.0", host_permissions: ["https://hote.test/*"], content_scripts: [{ matches: ["https://hote.test/*"], js: ["a.js"] }] },
        "a.js": `const r = {};
const essai = (nom, f) => { try { const v = f(); r[nom] = v === null ? "null" : "parti"; if (v && typeof v.then === "function") v.then(() => {}, (e) => { r[nom] = String(e && e.message); document.documentElement.setAttribute("data-sonde", JSON.stringify(r)); }); } catch (e) { r[nom] = String(e && e.message); } };
essai("open", () => window.open("https://autre.test/w-open"));
essai("selfOpen", () => self.open("https://autre.test/w-self-open"));
essai("open-nu", () => open("https://autre.test/w-open-nu"));
essai("fetch", () => window.fetch("https://autre.test/w-fetch"));
essai("xhr", () => { const x = new window.XMLHttpRequest(); x.open("GET", "https://autre.test/w-xhr"); x.send(); });
essai("ws", () => new window.WebSocket("wss://autre.test/w-ws"));
essai("source", () => new window.EventSource("https://autre.test/w-source"));
essai("fetch-hote", () => window.fetch("https://hote.test/w-fetch"));
document.documentElement.setAttribute("data-sonde", JSON.stringify(r));`,
      },
      { permissions: [], hosts: ["https://hote.test/*"], network: [], allSites: false, allSitesScripts: false, scripts: true },
    );
    const m = w.marionette;
    const tab = await openTab(m, "https://hote.test/sonde");
    await until(() => hitsTo("hote.test", "/w-fetch").length > 0);
    await sleep(1000);
    const seen = JSON.parse((await inPage<string>(m, tab, "return document.documentElement.getAttribute('data-sonde')"))!);
    expect(seen).toEqual({
      open: "null",
      selfOpen: "null",
      "open-nu": "null",
      fetch: "URL refusée par WebAiOs",
      xhr: "URL refusée par WebAiOs",
      ws: "URL refusée par WebAiOs",
      source: "URL refusée par WebAiOs",
      "fetch-hote": "parti",
    });
    expect(hitsTo("autre.test")).toEqual([]);
    expect(await m.execute<number>("return gBrowser.tabs.filter((t) => t.linkedBrowser.currentURI.spec.includes('autre.test')).length")).toBe(0);
  });

  // Firefox only: FormData and the on… handlers of the page's window (own members of a [Global] window), not the sandbox's.
  it("through window, FormData drops the password and the window's on… handlers get none of its events", async () => {
    const w = await launchAgent(
      "sonde",
      {
        "manifest.json": { manifest_version: 3, name: "Sonde", version: "1.0.0", host_permissions: ["https://hote.test/*"], content_scripts: [{ matches: ["https://hote.test/*"], js: ["a.js"] }] },
        "a.js": `const r = { touches: [] };
const noter = () => document.documentElement.setAttribute("data-sonde", JSON.stringify(r));
const f = document.getElementById("f");
r.window = new window.FormData(f).get("mdp");
r.self = new self.FormData(f).get("mdp");
r.nu = new FormData(f).get("mdp");
const voir = (nom) => (e) => { r.touches.push(nom + ":" + e.target.id); noter(); };
window.onkeydown = voir("window.onkeydown");
self.oninput = voir("self.oninput");
document.defaultView.onkeypress = voir("defaultView.onkeypress");
onkeyup = voir("onkeyup");
noter();`,
      },
      { permissions: [], hosts: ["https://hote.test/*"], network: [], allSites: false, allSitesScripts: false, scripts: true },
    );
    const m = w.marionette;
    const tab = await openTab(m, "https://hote.test/formulaire?sonde");
    const seen = () => inPage<string | null>(m, tab, "return document.documentElement.getAttribute('data-sonde')");
    await poll(seen, (v) => v !== null);
    await inPage(
      m,
      tab,
      `const ev = (el, type, key) => el.dispatchEvent(type === "input" ? new InputEvent("input", { bubbles: true, data: key }) : new KeyboardEvent(type, { key, bubbles: true }));
       const t = document.getElementById("texte"), p = document.getElementById("mdp");
       for (const type of ["keydown", "keypress", "input", "keyup"]) { ev(p, type, "b"); ev(t, type, "a"); }`,
    );
    await sleep(300);
    expect(JSON.parse((await seen())!)).toEqual({
      window: null,
      self: null,
      bare: null,
      keys: ["window.onkeydown:texte", "defaultView.onkeypress:texte", "self.oninput:texte", "onkeyup:texte"],
    });
  });

  // The shared world is read from the page.
  it("I2 all the files of its content scripts share one world: a var of one entry is read in another, a redeclared const throws", async () => {
    const w = await launchAgent(
      "monde",
      {
        "manifest.json": {
          manifest_version: 3,
          name: "Monde de l'agent",
          version: "1.0.0",
          host_permissions: ["https://hote.test/*"],
          content_scripts: [
            { matches: ["https://hote.test/*"], js: ["a.js"] },
            { matches: ["https://hote.test/*"], js: ["b.js"] },
            { matches: ["https://hote.test/*"], js: ["c.js"] },
          ],
        },
        "a.js": 'var partage = "de a";\nconst doublon = 1;\n',
        "b.js": 'document.documentElement.setAttribute("data-b", "b voit:" + partage);\n',
        "c.js": 'const doublon = 2;\ndocument.documentElement.setAttribute("data-c", "c fini");\n',
      },
      { permissions: [], hosts: ["https://hote.test/*"], network: [], allSites: false, allSitesScripts: false, scripts: true },
    );
    const m = w.marionette;
    const tab = await openTab(m, "https://hote.test/monde");
    const marks = () => inPage<(string | null)[]>(m, tab, "return ['data-b', 'data-c'].map((a) => document.documentElement.getAttribute(a))");
    expect(await poll(marks, (v) => v[0] !== null)).toEqual(["b voit:de a", null]);
    await sleep(500);
    expect(await marks()).toEqual(["b voit:de a", null]);
  });

  it("an unreadable tab marks the extension's console as masked, for good", async () => {
    const w = await launchGuard();
    const m = w.marionette;
    // A tab the agent was never given: not readable.
    const tab = await openTab(m, "https://hote.test/formulaire?masque");
    expect((await poll(() => seenByAgent(m, tab), (v) => v?.ecoute === true))?.ecoute).toBe(true);
    const registry = () => JSON.parse(readFileSync(path.join(w.dataDir, "extensions", "state.json"), "utf8"));
    await until(() => registry().consolesMasquees?.includes("garde@agent.webaios"));
    expect(registry().extensions["agent:garde"].consoleMasquee).toEqual(["default"]);
    expect(registry().consolesMasquees).toEqual(["garde@agent.webaios"]);
  });
});

describe("agent extensions: tabs without the tabs right or a host", () => {
  /**
   * The spy background: what the background sees of the tabs by tabs.query, tabs.get,
   * windows.getAll({ populate: true }) and the onUpdated/onCreated events; `ordre.html?snap` returns it.
   */
  const spy = (manifest: object) => ({
    "manifest.json": { manifest_version: 3, name: "Espion de l'agent", version: "1.0.0", background: { service_worker: "fond.js" }, ...manifest },
    "webaios.json": { network: [] },
    "fond.js": `const montrer = (t) => ({ id: t.id, url: t.url ?? null, title: t.title ?? null, favIconUrl: t.favIconUrl ?? null, pendingUrl: t.pendingUrl ?? null });
const events = [];
chrome.tabs.onUpdated.addListener((id, c, t) => events.push({ maj: c, tab: montrer(t) }));
chrome.tabs.onCreated.addListener((t) => events.push({ cree: montrer(t) }));
chrome.runtime.onMessage.addListener((m, _e, repondre) => {
  if (m !== "snap") return;
  (async () => {
    const query = (await chrome.tabs.query({})).map(montrer);
    const gets = [];
    for (const t of query) gets.push(montrer(await chrome.tabs.get(t.id)));
    const fenetres = (await chrome.windows.getAll({ populate: true })).flatMap((f) => (f.tabs ?? []).map(montrer));
    return JSON.stringify({ query, gets, fenetres, events });
  })().then(repondre, (e) => repondre("erreur " + (e && e.message)));
  return true;
});
`,
    "ordre.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="ordre.js"></script></body></html>',
    "ordre.js": `chrome.runtime.sendMessage(location.search.slice(1)).then((r) => (document.title = String(r)), (e) => (document.title = "erreur " + e.message));
`,
  });
  const grantOf = (permissions: string[], hosts: string[]) => ({ permissions, hosts: hosts, network: [], allSites: false, allSitesScripts: false, scripts: false });
  type Seen = { id: number; url: string | null; title: string | null; favIconUrl: string | null; pendingUrl: string | null };
  const snap = async (w: LaunchedWebAiOs & { uuid: string }) =>
    JSON.parse(await order(w, "snap")) as { query: Seen[]; gets: Seen[]; windows: Seen[]; events: ({ update?: object; tab: Seen } | { created: Seen })[] };
  const everything = (v: object) => JSON.stringify(v);

  /** Opens an own-site and a foreign tab, waits for the proxy to have served both. */
  async function openBoth(w: LaunchedWebAiOs) {
    await openTab(w.marionette, "https://hote.test/a");
    await until(() => hitsTo("hote.test", "/a").length > 0);
    await openTab(w.marionette, "https://autre.test/b");
    await until(() => hitsTo("autre.test", "/b").length > 0);
    await sleep(1000);
  }

  it("without tabs nor a host: no address nor title in tabs.query, tabs.get, onUpdated, onCreated, windows populate", async () => {
    const w = await launchAgent("espion", spy({}), grantOf([], []));
    await openBoth(w);
    const seen = await snap(w);
    expect(seen.query.length).toBeGreaterThan(1);
    for (const part of [seen.query, seen.gets, seen.windows, seen.events]) {
      const text = everything(part);
      for (const secret of ["hote.test", "autre.test", "/a\"", "/b\"", "about:blank"]) expect(text, secret).not.toContain(secret);
    }
    expect(seen.events.length).toBeGreaterThan(0);
  });

  it("with a host: the address and title of that site's tabs only", async () => {
    const w = await launchAgent("espion", spy({ host_permissions: ["https://hote.test/*"] }), grantOf([], ["https://hote.test/*"]));
    await openBoth(w);
    const seen = await snap(w);
    for (const [name, part] of Object.entries({ query: seen.query, gets: seen.gets, windows: seen.windows, events: seen.events })) {
      const text = everything(part);
      expect(text, name).toContain('"https://hote.test/a"');
      expect(text, name).not.toContain("autre.test");
    }
    expect(seen.query.find((t) => t.url === "https://hote.test/a")?.title).toBe("/a");
  });

  // « tabs » shows every address. The parking tab and the invisible reads are no tab.
  it("the parking tab and reading browsers are never listed", async () => {
    const w = await launchAgent("espion", spy({ permissions: ["tabs"] }), grantOf(["tabs"], []));
    await openTab(w.marionette, "https://hote.test/a");
    await until(() => hitsTo("hote.test", "/a").length > 0);
    const seen = await snap(w);
    // Only the tab opened and the extension's own page (the snap's): the parking tab (about:blank) is not listed, nor is its id.
    const urls = seen.query.map((t) => t.url ?? "");
    expect(urls.length).toBe(2);
    expect(urls).toContain("https://hote.test/a");
    expect(urls.filter((u) => /^moz-extension:\/\/[^/]+\/ordre\.html\?snap$/.test(u)).length).toBe(1);
    const ids = new Set(seen.query.map((t) => t.id));
    const eventIds = seen.events.map((e) => ("created" in e ? e.created.id : e.tab.id));
    for (const id of [...seen.gets.map((t) => t.id), ...seen.windows.map((t) => t.id), ...eventIds]) expect(ids.has(id), `tab ${id}`).toBe(true);
    expect(seen.windows.length).toBe(seen.query.length);
  });
});
