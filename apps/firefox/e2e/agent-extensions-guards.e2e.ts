import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ecrireExtensionAgent } from "../../navigateur/e2e/extensions/fixtures";
import { installAddon } from "./addons";
import { grant, launchWithAmo, openTab } from "./agent-extensions";
import { waitFor } from "./firefox";
import type { LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";

// Ported from Electron's extensions-agent.spec.ts (the network guard, :477 to :726). Electron maps the test domains
// with --host-resolver-rules; here Firefox sends every https request to a recording proxy, which answers CONNECT and
// serves the tunnel with a self-signed certificate (Firefox's certificate checks turned off for the run). « Nothing
// leaves » is checked by `hits`: what the proxy saw, by host and path (a bare tunnel is « (connexion) »).
const ID = "reseau@agent.webaios";

type Hit = { hote: string; chemin: string };
let proxy: { port: number; hits: Hit[]; close(): Promise<void> };
let certs: string;
let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer();
  certs = mkdtempSync(path.join(os.tmpdir(), "webaios-cert-"));
  const [key, cert] = [path.join(certs, "key.pem"), path.join(certs, "cert.pem")];
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=accorde.test"], { stdio: "ignore" });
  const hits: Hit[] = [];
  const note = (host: string | undefined, url: string | undefined) => hits.push({ hote: (host ?? "").split(":")[0]!, chemin: (url ?? "").split("?")[0]! });
  const tls = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    note(req.headers.host, req.url);
    req.resume();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(`<title>${req.url}</title>ok`);
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

const hitsTo = (hote: string, chemin?: string) => proxy.hits.filter((c) => c.hote === hote && (chemin === undefined || c.chemin === chemin));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(100);
  }
}

/**
 * Electron's EXTENSION_RESEAU (extensions-agent.spec.ts), the files these tests use: `reseau` accorde.test, hosts
 * https://hote.test/*. Its background sends to accorde.test and autre.test (fetch, WebSocket), then tries the guarded
 * APIs and keeps what it got in `storage.local` (`resultats`). Firefox: `clients-type` answers typeof clients (absent
 * from a background page, spike S2); `resultats.html` shows the results in its title.
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
  await essai("rtc", () => typeof globalThis.RTCPeerConnection);
  await chrome.storage.local.set({ resultats });
})();
chrome.runtime.onMessage.addListener((m, _expediteur, repondre) => {
  (async () => {
    if (m === "popup-fuite") {
      await chrome.action.setPopup({ popup: "https://autre.test/popup-fuite" });
      await chrome.action.openPopup().catch(() => {});
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
  "ordre.html": '<!doctype html><html><head><meta charset="utf-8"><title>attente</title></head><body><script src="ordre.js"></script></body></html>',
  "ordre.js": `chrome.runtime.sendMessage(location.search.slice(1)).then((r) => (document.title = String(r)), (e) => (document.title = "erreur " + e.message));
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

const dirs: string[] = [];
const opened: LaunchedWebAiOs[] = [];
afterEach(async () => {
  for (const w of opened.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The « réseau » extension granted, WebAiOs launched behind the recording proxy; resolves once it is installed and running. */
async function launchReseau(): Promise<LaunchedWebAiOs & { uuid: string }> {
  const f = { dataDir: mkdtempSync(path.join(os.tmpdir(), "webaios-data-")), profile: mkdtempSync(path.join(os.tmpdir(), "webaios-firefox-")) };
  dirs.push(f.dataDir, f.profile);
  ecrireExtensionAgent(path.join(f.dataDir, "espace"), "reseau", EXTENSION_RESEAU);
  grant(f.dataDir, "reseau", ACCORD_RESEAU);
  const prefs = {
    "network.proxy.type": 1,
    "network.proxy.http": "127.0.0.1",
    "network.proxy.http_port": proxy.port,
    "network.proxy.ssl": "127.0.0.1",
    "network.proxy.ssl_port": proxy.port,
  };
  const w = await launchWithAmo({ ...f, prefs });
  opened.push(w);
  // The proxy's self-signed certificate: accepted for this run (as Electron's --ignore-certificate-errors).
  await w.marionette.execute(
    'Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).setDisableAllSecurityChecksAndLetAttackersInterceptMyData(true);',
  );
  const uuid = await waitFor<string | null>(
    w.marionette,
    `return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const a = await AddonManager.getAddonByID(${JSON.stringify(ID)});
      return a?.isActive ? WebExtensionPolicy.getByID(${JSON.stringify(ID)})?.mozExtensionHostname ?? null : null;
    })();`,
    (v) => !!v,
    30_000,
  );
  return { ...w, uuid: uuid! };
}

/**
 * Opens a page of the extension in a tab, waits until its title leaves « attente », then `ms` more; returns its title
 * and address, then closes it.
 */
async function extensionPage(m: Marionette, url: string, ms = 1500): Promise<{ titre: string; url: string }> {
  await m.execute("window.extensionTab = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });", [url]);
  await waitFor(m, "return window.extensionTab.linkedBrowser.contentTitle", (t: string) => !!t && t !== "attente", 20_000);
  await sleep(ms);
  const r = await m.execute<{ titre: string; url: string }>(
    "const b = window.extensionTab.linkedBrowser; return { titre: b.contentTitle, url: b.currentURI.spec };",
  );
  await m.execute("gBrowser.removeTab(window.extensionTab);");
  return r;
}

const order = async (w: LaunchedWebAiOs & { uuid: string }, what: string) => (await extensionPage(w.marionette, `moz-extension://${w.uuid}/ordre.html?${what}`, 0)).titre;

describe("agent extensions: network guard", () => {
  it("the background cannot send to a domain not granted (fetch, WebSocket); to the granted one, yes", async () => {
    await launchReseau();
    await until(() => hitsTo("accorde.test", "/sw-fetch").length > 0);
    await until(() => hitsTo("accorde.test", "/sw-ws").length > 0);
    await sleep(1000);
    expect(hitsTo("autre.test")).toEqual([]);
  });

  it("nor its pages (fetch, sendBeacon, WebSocket, navigation, window.open); RTCPeerConnection is absent from them", async () => {
    const w = await launchReseau();
    const page = await extensionPage(w.marionette, `moz-extension://${w.uuid}/page.html`);
    expect(JSON.parse(page.titre)).toEqual({ rtc: "undefined", rtcWebkit: "undefined", canal: "undefined", ouverture: "null" });
    // The navigation to autre.test was refused: the page stayed its own.
    expect(page.url).toBe(`moz-extension://${w.uuid}/page.html`);
    await until(() => hitsTo("accorde.test", "/page-fetch").length > 0);
    await until(() => hitsTo("accorde.test", "/page-beacon").length > 0);
    await until(() => hitsTo("accorde.test", "/page-ws").length > 0);
    expect(hitsTo("autre.test")).toEqual([]);
    expect(hitsTo("hote.test", "/page-ouvre")).toEqual([]);
  });

  it("tabs.create to a domain not granted is refused, to a site of its hosts opened; a DNR redirect is refused, a block accepted", async () => {
    const w = await launchReseau();
    const r = JSON.parse((await extensionPage(w.marionette, `moz-extension://${w.uuid}/resultats.html`, 0)).titre);
    expect(r).toMatchObject({
      ongletRefuse: { erreur: "URL refusée par WebAiOs" },
      ongletDonnees: { erreur: "URL refusée par WebAiOs" },
      ongletPermis: { ok: "number" },
      fenetreRefusee: { erreur: "URL refusée par WebAiOs" },
      dnrRedirect: { erreur: "Règle DNR refusée par WebAiOs (redirect)" },
      dnrEntetes: { erreur: "Règle DNR refusée par WebAiOs (modifyHeaders)" },
      dnrBlock: { ok: "acceptee" },
      dnrRegles: { ok: ["block"] },
      rtc: { ok: "undefined" },
    });
    await until(() => hitsTo("hote.test", "/onglet-permis").length > 0);
    expect(hitsTo("autre.test")).toEqual([]);
  });

  // Electron's Store extension: here an AMO-style add-on installed temporarily, blocking by a static DNR ruleset and
  // fetching where it likes.
  it("with an agent extension running, another add-on still blocks (DNR) and sends where it likes; pages load", async () => {
    const w = await launchReseau();
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
    const w = await launchReseau();
    const m = w.marionette;
    // An active tab in the window: the popup has somewhere to anchor.
    await openTab(m, "https://hote.test/ancre");
    await until(() => hitsTo("hote.test", "/ancre").length > 0);
    // Firefox refuses an absolute popup address itself; Electron answered « fait ».
    expect(await order(w, "popup-fuite")).toMatch(/^(fait|Access denied for URL https:\/\/autre\.test\/popup-fuite)$/);
    await waitFor(m, `return !!window.webaiosWindow.addons.buttons().find((b) => b.id === ${JSON.stringify(ID)})?.enabled`, (v) => v === true);
    await m.execute(`window.webaiosWindow.addons.click(arguments[0], { x: 0, y: 0, width: 24, height: 24 });`, [ID]);
    await sleep(1500);
    expect(hitsTo("autre.test")).toEqual([]);
  });

  // Measured: Electron reads a hole of the list through Array.prototype (Store extension, no guard); an agent
  // extension's holey list is refused without the prototype's getter being read. The agent half only.
  it("updateDynamicRules with a holey list: the agent's guard refuses it", async () => {
    const w = await launchReseau();
    const page = await extensionPage(w.marionette, `moz-extension://${w.uuid}/tableaux.html`, 0);
    expect(JSON.parse(page.titre)).toEqual({ erreur: "Règle DNR refusée par WebAiOs (tableau à trous)", lus: 0, regles: ["block"] });
  });

  it("dns-prefetch, preconnect, prefetch… links of an agent page to a domain not granted contact nothing", async () => {
    const w = await launchReseau();
    const page = await extensionPage(w.marionette, `moz-extension://${w.uuid}/liens.html`);
    // All set (no refusal from the DOM): it is the network that does not go.
    expect(Object.values(JSON.parse(page.titre) as Record<string, string>).every((v) => v === "pose")).toBe(true);
    expect(proxy.hits.filter((c) => c.hote.endsWith("autre.test"))).toEqual([]);
  });

  // Electron's clients.openWindow half: a Firefox background page has no `clients` (spike S2).
  it("runtime.setUninstallURL to a domain not granted opens nothing, uninstall included; no clients in the background", async () => {
    const w = await launchReseau();
    const m = w.marionette;
    expect(await order(w, "clients-type")).toBe("undefined");
    expect(await order(w, "desinstallation")).toMatch(/^(posee|erreur .*)$/);
    await m.command("Addon:Uninstall", { id: ID });
    await sleep(1500);
    expect(await m.execute<number>("return gBrowser.tabs.filter((t) => t.linkedBrowser.currentURI.spec.includes('autre.test')).length")).toBe(0);
    expect(hitsTo("autre.test")).toEqual([]);
  });

  // Electron's :613 and :657. Measured (task 5): an about:blank frame of an agent page is not matched by the extension
  // actor (no __webaios, window.open not refused), and Firefox gives it the whole extension API without the guard
  // (a DNR redirect is accepted) and RTCPeerConnection; srcdoc frames are cross-origin. Limit in the README.
  it.todo("in its popup, an about:blank, srcdoc, nested or shadow-root frame has neither RTCPeerConnection nor a way to set a DNR redirect");
  it.todo("document.write of a frame while loading: no child window has RTCPeerConnection in the same task");
});
