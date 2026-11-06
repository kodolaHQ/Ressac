import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ecrireExtensionAgent } from "../../navigateur/e2e/extensions/fixtures";
import { cleanupXpis, installAddon, marker, type Fixture } from "./addons";
import { grant, launchWithAmo, testActor } from "./agent-extensions";
import { state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { ICON } from "./server";
import { grantSite, inBrowser, inSiteBar, inSiteView, resolveLocalHosts, serveWav, silenceWav, siteWindowExpr, startSitesServer, writeSite, type SiteTest } from "./sites";
import { inUi, missingApi, waitUi } from "./ui";

// Plan 32 Task 6: Firefox add-ons in a site app's window. Their buttons in the app's bar (the « site » view only), their
// popups in the app's window, and the app view protected from them. Ports of Electron's e2e/extensions-sites.spec.ts
// where they still apply: add-ons run everywhere in Firefox, there is no per-app activation (spec §4.9).

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const HOSTS = ["vidola-a.localhost", "pub.localhost", "compte.localhost", "lecteur.localhost"];
const PROBE = "site-probe@webaios.test";
const PROTECTED = "Onglet protégé par WebAiOs";
const REFUSED = "Chargement refusé par WebAiOs";
const STRIP_BUTTON = '[data-testid="action-extension-site"]';

/**
 * A button whose popup takes orders from the test: the test writes `order <n> <json>` as the view's page title, the
 * popup reads it through tabs.query (its current window's active tab) and writes `result <n> <json>` as its own title.
 */
const POPUP_JS = `let done = 0;
const run = async (o, t) => {
  if (o.op === "query") return { url: t.url, windowId: t.windowId, current: (await browser.windows.getCurrent()).id, count: (await browser.tabs.query({ currentWindow: true })).length };
  if (o.op === "update") return browser.tabs.update(t.id, { url: o.url }).then(() => "updated");
  if (o.op === "create") return browser.tabs.create({ url: o.url }).then((n) => (n.windowId === t.windowId ? "same-window" : "other-window"));
  if (o.op === "remove") return browser.tabs.remove(t.id).then(() => "removed");
  if (o.op === "move-here") return browser.tabs.move(t.id, { index: -1 }).then(() => "moved");
  if (o.op === "move") {
    const other = (await browser.windows.getAll()).find((x) => x.id !== t.windowId);
    return browser.tabs.move(t.id, { windowId: other.id, index: 0 }).then(() => "moved");
  }
  if (o.op === "window") return browser.windows.create({ tabId: t.id }).then(() => "window");
  if (o.op === "close-window") return browser.windows.remove(t.windowId).then(() => "closed");
  if (o.op === "reload") return browser.tabs.reload(t.id).then(() => "reloaded");
  if (o.op === "back") return browser.tabs.goBack(t.id).then(() => "back");
};
setInterval(async () => {
  const [t] = await browser.tabs.query({ active: true, currentWindow: true });
  const m = /^order (\\d+) (.*)$/.exec((t && t.title) || "");
  if (!m || Number(m[1]) <= done) return;
  const n = (done = Number(m[1]));
  let r;
  try {
    r = { ok: await run(JSON.parse(m[2]), t) };
  } catch (e) {
    r = { error: String(e && e.message) };
  }
  document.title = "result " + n + " " + JSON.stringify(r);
}, 100);
document.title = "Popup prête";`;
const probe = (): Fixture => ({
  id: PROBE,
  manifest: {
    manifest_version: 2,
    name: "Sonde de l'appli",
    version: "1.0",
    browser_specific_settings: { gecko: { id: PROBE } },
    permissions: ["tabs"],
    browser_action: { default_icon: "icon.png", default_title: "Sonde de l'appli", default_popup: "popup.html" },
  },
  files: { "icon.png": ICON, "popup.html": '<!doctype html><meta charset="utf-8"><title>Popup</title><script src="popup.js"></script>', "popup.js": POPUP_JS },
});

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs | undefined;
let m: Marionette;
let dataDir: string;
let profile: string;

const url = (p: string, host = "vidola-a.localhost") => server.url(host, p);
const vidola = (extra: object = {}) => ({ nom: "Vidola", adresse: url("/pubs"), domaines: ["vidola-a.localhost"], connexion: ["compte.localhost"], ...extra });
/** Electron's avecAccueil: an app with a home screen (the « accueil » view on opening). */
const withHome = (): SiteTest => ({ declaration: { ...vidola(), nom: "Tube" }, fichiers: { "accueil/index.html": "<p>accueil</p>" } });
/** Electron's avecCarte: retouches without an accord, so the accord card shows on opening. */
const withCard = (): SiteTest => ({
  declaration: { ...vidola({ retouches: [{ correspond: ["/pubs"], js: ["a.js"] }] }), nom: "Carte" },
  fichiers: { "retouches/a.js": 'document.body.dataset.retouche = "oui";' },
});

const inStore = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
const openSite = (id: string) => inStore(`await store.agent.request("sites.agir", { id: arguments[0], action: "ouvrir", fenetre: store.state.fenetres[0].id });`, [id]);
const viewUrl = (id = "vidola") => m.execute<string>(`const u = ${siteWindowExpr(id)}?.gBrowser?.selectedBrowser.currentURI?.spec ?? ""; return u === "about:blank" ? "" : u;`);
const view = <T = unknown>(expr: string, id = "vidola") => inSiteView<T>(m, id, `return ${expr};`).catch(() => null);
const siteState = (id = "vidola") => m.execute<{ vue: string }>(`return JSON.parse(JSON.stringify(${siteWindowExpr(id)}.webaiosSiteWindow.state()));`);
const stripButtons = (id = "vidola") => inSiteBar<number>(m, id, `return doc.querySelectorAll(${JSON.stringify(STRIP_BUTTON)}).length;`);
const tabCount = (id = "vidola") => m.execute<number>(`return ${siteWindowExpr(id)}.gBrowser.tabs.length;`);
const popupExpr = (id: string) => `${siteWindowExpr(id)}.document.querySelector("browser.webextension-popup-browser")`;

async function start(o: { sites?: Record<string, SiteTest>; granted?: string[] } = {}) {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  const sites = o.sites ?? { vidola: { declaration: vidola() } };
  for (const [id, s] of Object.entries(sites)) writeSite(dataDir, id, s);
  for (const id of o.granted ?? []) await grantSite(dataDir, id, sites[id]!.declaration as object);
  const actor = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1", ...actor.env }, prefs: actor.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, HOSTS);
}

/** Electron's ouvrirEtAttendre: the app opened, its view on `chemin` and loaded. */
async function openAndWait(id = "vidola", chemin = "/pubs") {
  await openSite(id);
  await expect.poll(() => viewUrl(id), { timeout: 15_000 }).toBe(url(chemin));
  await expect.poll(() => view("document.readyState", id), { timeout: 10_000 }).not.toBe("loading");
}

/** Clicks the probe's button in the app's bar; resolves once its popup ran its script. */
async function openPopup(id = "vidola") {
  await expect.poll(() => inSiteBar<boolean>(m, id, `const b = doc.querySelector(${JSON.stringify(STRIP_BUTTON)}); return !!b && !b.disabled;`), { timeout: 10_000 }).toBe(true);
  await inSiteBar(m, id, `doc.querySelector(${JSON.stringify(STRIP_BUTTON)}).click();`);
  await waitFor(m, `return ${popupExpr(id)}?.contentTitle`, (t) => t === "Popup prête", 15_000);
}

let orders = 0;
/** One order to the open popup (see POPUP_JS), through the view's title; its answer. */
async function order(o: object, id = "vidola"): Promise<{ ok?: unknown; error?: string }> {
  const n = ++orders;
  await inSiteView(m, id, `document.title = ${JSON.stringify(`order ${n} ${JSON.stringify(o)}`)}; return 1;`);
  const t = await waitFor<string>(m, `return ${popupExpr(id)}?.contentTitle ?? ""`, (x) => x.startsWith(`result ${n} `), 15_000);
  return JSON.parse(t.slice(`result ${n} `.length));
}

beforeAll(async () => {
  server = await startSitesServer();
  server.definir("vidola-a.localhost", "/pubs", '<title>Pubs</title><div class="pub" id="banniere">pub</div>');
  server.definir("vidola-a.localhost", "/film/2", "<title>Film 2</title>");
  server.definir("pub.localhost", "/ouvert", "<title>Ouvert</title>");
});
afterAll(async () => {
  await server?.fermer();
  await cleanupXpis();
});
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close().catch(() => {});
    w = undefined;
    server.requetes.splice(0);
    await rm(dataDir, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});

describe("add-ons in a site app window", () => {
  it("clicking the button: the popup opens in the app's window, tabs.query({ active, currentWindow }) gives the view's tab (extensions-sites.spec.ts:482)", async () => {
    await start();
    await installAddon(m, probe());
    await openAndWait();
    expect(await stripButtons()).toBe(1);
    await openPopup();
    // The popup's panel is the app window's, never the main window's.
    expect(await m.execute("return !!document.querySelector('browser.webextension-popup-browser')")).toBe(false);
    const r = await order({ op: "query" });
    expect(r.error).toBeUndefined();
    const q = r.ok as { url: string; windowId: number; current: number; count: number };
    expect(q.url).toBe(url("/pubs"));
    expect(q.windowId).toBe(q.current);
    expect(q.count).toBe(1);
  });

  it("tabs.create to pub.localhost from the popup opens a tab of the main window, none in the app (extensions-sites.spec.ts:255, adapted)", async () => {
    await start();
    await installAddon(m, probe());
    await openAndWait();
    await openPopup();
    const ouvert = url("/ouvert", "pub.localhost");
    expect(await order({ op: "create", url: ouvert })).toEqual({ ok: "other-window" });
    await expect.poll(async () => Object.values((await state(m)).onglets).map((o) => o.url), { timeout: 10_000 }).toContain(ouvert);
    expect(await tabCount()).toBe(1);
    expect(await viewUrl()).toBe(url("/pubs"));
  });

  it("tabs.update of the view to an add-on page is refused; the view stays on its http page (extensions-sites.spec.ts:501)", async () => {
    await start();
    await installAddon(m, probe());
    await openAndWait();
    await openPopup();
    expect(await order({ op: "update", url: "popup.html" })).toEqual({ error: REFUSED });
    await new Promise((r) => setTimeout(r, 500));
    expect(await viewUrl()).toBe(url("/pubs"));
    expect(await view("location.protocol")).toBe("http:");
  });

  it("no add-on button on the home screen nor on the accord card (extensions-sites.spec.ts:542)", async () => {
    await start({ sites: { tube: withHome(), carte: withCard() } });
    await installAddon(m, probe());
    // Home.
    await openSite("tube");
    await expect.poll(() => siteState("tube").then((s) => s.vue), { timeout: 15_000 }).toBe("accueil");
    await new Promise((r) => setTimeout(r, 500));
    expect(await stripButtons("tube")).toBe(0);
    const enabled = (id: string) => m.execute<boolean[]>(`return ${siteWindowExpr(id)}.webaiosSiteWindow.addons.buttons().map((b) => b.enabled);`);
    expect(await enabled("tube")).toEqual([false]);
    await m.execute(`${siteWindowExpr("tube")}.webaiosSiteWindow.enter()`);
    await expect.poll(() => stripButtons("tube"), { timeout: 10_000 }).toBe(1);
    await m.execute(`${siteWindowExpr("tube")}.webaiosSiteWindow.home()`);
    await expect.poll(() => stripButtons("tube"), { timeout: 10_000 }).toBe(0);
    // Accord card.
    await openSite("carte");
    await expect.poll(() => siteState("carte").then((s) => s.vue), { timeout: 15_000 }).toBe("accord");
    await new Promise((r) => setTimeout(r, 500));
    expect(await stripButtons("carte")).toBe(0);
    expect(await enabled("carte")).toEqual([false]);
  });

  it("on the home screen, tabs.update of the view to a page of the app is refused: no request to the site, the view stays where it is (extensions-sites.spec.ts:655)", async () => {
    await start({ sites: { tube: withHome() } });
    await installAddon(m, probe());
    await openSite("tube");
    await expect.poll(() => siteState("tube").then((s) => s.vue), { timeout: 15_000 }).toBe("accueil");
    await m.execute(`${siteWindowExpr("tube")}.webaiosSiteWindow.enter()`);
    await expect.poll(() => viewUrl("tube"), { timeout: 15_000 }).toBe(url("/pubs"));
    await expect.poll(() => view("document.readyState", "tube"), { timeout: 10_000 }).toBe("complete");
    // The popup opened on the « site » view stays open once back on the home.
    await openPopup("tube");
    await m.execute(`${siteWindowExpr("tube")}.webaiosSiteWindow.home()`);
    expect((await siteState("tube")).vue).toBe("accueil");
    server.requetes.splice(0);
    expect(await order({ op: "update", url: url("/film/2") }, "tube")).toEqual({ error: REFUSED });
    await new Promise((r) => setTimeout(r, 500));
    expect(server.requetes.filter((r) => r.hote === "vidola-a.localhost")).toEqual([]);
    expect(await viewUrl("tube")).toBe(url("/pubs"));
    expect((await siteState("tube")).vue).toBe("accueil");
  });

  it("on the home screen, tabs.reload and tabs.goBack of the view send no request; the view stays where it is (Electron's M1, fenetres.ts:415)", async () => {
    await start({ sites: { tube: withHome() } });
    await installAddon(m, probe());
    await openSite("tube");
    await expect.poll(() => siteState("tube").then((s) => s.vue), { timeout: 15_000 }).toBe("accueil");
    await m.execute(`${siteWindowExpr("tube")}.webaiosSiteWindow.enter()`);
    await expect.poll(() => viewUrl("tube"), { timeout: 15_000 }).toBe(url("/pubs"));
    await view(`(location.href = ${JSON.stringify(url("/film/2"))}, 1)`, "tube");
    await expect.poll(() => viewUrl("tube"), { timeout: 15_000 }).toBe(url("/film/2"));
    await expect.poll(() => view("document.readyState", "tube"), { timeout: 10_000 }).not.toBe("loading");
    await openPopup("tube");
    await m.execute(`${siteWindowExpr("tube")}.webaiosSiteWindow.home()`);
    server.requetes.splice(0);
    expect((await order({ op: "reload" }, "tube")).error).toBeUndefined();
    expect((await order({ op: "back" }, "tube")).error).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1000));
    expect(server.requetes.filter((r) => r.hote === "vidola-a.localhost")).toEqual([]);
    expect(await viewUrl("tube")).toBe(url("/film/2"));
    expect((await siteState("tube")).vue).toBe("accueil");
  });

  it("windows.remove of the app's window is refused (extensions-sites.spec.ts peutFermerFenetre, sessions.ts:594)", async () => {
    await start();
    await installAddon(m, probe());
    await openAndWait();
    await openPopup();
    expect(await order({ op: "close-window" })).toEqual({ error: PROTECTED });
    await new Promise((r) => setTimeout(r, 500));
    expect(await tabCount()).toBe(1);
    expect(await viewUrl()).toBe(url("/pubs"));
  });

  it("tabs.remove and tabs.move on the app view leave it in place", async () => {
    await start();
    await installAddon(m, probe());
    await openAndWait();
    await openPopup();
    expect(await order({ op: "remove" })).toEqual({ error: PROTECTED });
    expect(await order({ op: "move" })).toEqual({ error: PROTECTED });
    expect(await order({ op: "move-here" })).toEqual({ ok: "moved" });
    // windows.create({ tabId }): a window opens, the view does not go into it.
    expect((await order({ op: "window" })).error).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1000));
    expect(await tabCount()).toBe(1);
    expect(await viewUrl()).toBe(url("/pubs"));
    const elsewhere = await m.execute<string[]>(
      `return [...Services.wm.getEnumerator("navigator:browser")].filter((w) => !w.document.documentElement.hasAttribute("webaios-site")).flatMap((w) => w.gBrowser.browsers.map((b) => b.currentURI.spec));`,
    );
    expect(elsewhere.filter((u) => u.includes("vidola-a.localhost"))).toEqual([]);
    expect(await view("document.title")).toMatch(/^order /);
  });

  it("the strip's styles stay out of the main UI", async () => {
    await start();
    await installAddon(m, probe());
    await openAndWait();
    await expect.poll(() => stripButtons(), { timeout: 10_000 }).toBe(1);
    const rules = "return [...doc.styleSheets].some((s) => [...s.cssRules].some((r) => r.cssText.includes('site-addon')));";
    expect(await inSiteBar<boolean>(m, "vidola", rules)).toBe(true);
    expect(await inUi<boolean>(m, rules)).toBe(false);
  });
});

describe("add-ons and what the agent adds to the app", () => {
  const SERIE = "/serie/the-bear";
  const RETENU = { titre: "The Bear", episode: "S2E4" };
  const serie = () =>
    vidola({
      adresse: url(SERIE),
      reprise: true,
      retouches: [{ correspond: ["/serie/*"], js: ["serie.js"], css: ["cacher.css"] }],
    });
  const memory = () => {
    const f = path.join(dataDir, "sites", "vidola", "memoire.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { valeurs: Record<string, { valeur: unknown; adresse: string }>; positions: Record<string, { t: number; duree: number }> }) : null;
  };

  it("with an add-on running in the view: the CSS retouche hides .shorts, the memory receives encours.the-bear, the resume notes the position (extensions-sites.spec.ts:1018, adapted)", async () => {
    server.definir("vidola-a.localhost", SERIE, `<title>The Bear</title><div class="shorts" id="shorts">shorts</div><video id="v" muted autoplay preload="auto" src="${url("/silence-90.wav", "lecteur.localhost")}"></video>`);
    server.definir("lecteur.localhost", "/silence-90.wav", serveWav(silenceWav(90)));
    const sites = {
      vidola: {
        declaration: serie(),
        fichiers: {
          "retouches/serie.js": `webaiosSite.retenir("encours.the-bear", ${JSON.stringify(RETENU)}).then(() => (document.documentElement.dataset.retenu = "oui"));`,
          "retouches/cacher.css": ".shorts { display: none; }",
        },
      },
    };
    await start({ sites, granted: ["vidola"] });
    await installAddon(m, marker());
    await installAddon(m, probe());
    await openAndWait("vidola", SERIE);
    // The add-ons run in the view (the marker's content script); both are in the bar, the marker greyed (no action).
    await expect.poll(() => view("document.getElementById('addon-mark')?.textContent ?? null"), { timeout: 10_000 }).toBe("MARQUE-MODULE");
    await expect.poll(() => stripButtons(), { timeout: 10_000 }).toBe(2);
    // The retouches.
    expect(await view("getComputedStyle(document.getElementById('shorts')).display")).toBe("none");
    await expect.poll(() => view("document.documentElement.dataset.retenu ?? null"), { timeout: 10_000 }).toBe("oui");
    await expect.poll(() => memory()?.valeurs["encours.the-bear"] ?? null, { timeout: 10_000 }).toMatchObject({ valeur: RETENU, adresse: SERIE });
    // The resume (see sites-resume.e2e.ts: the headless browser decodes nothing, the position is currentTime as set).
    await expect.poll(() => view("document.getElementById('v').duration"), { timeout: 15_000 }).toBe(90);
    await new Promise((r) => setTimeout(r, 500));
    await view("(() => { const v = document.getElementById('v'); v.currentTime = 70; v.play().catch(() => {}); v.pause(); return 1; })()");
    await expect.poll(() => memory()?.positions[SERIE]?.t ?? null, { timeout: 10_000 }).toBeCloseTo(70, 0);
  });
});

describe("the agent and the app's add-ons", () => {
  it("lister_onglets lists no page of the app outside site:<id> (extensions-sites.spec.ts:1119)", async () => {
    await start();
    await installAddon(m, probe());
    await openAndWait();
    const config = path.join(dataDir, "espace", ".webaios", "mcp.json");
    for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > deadline) throw new Error("the noyau did not write its MCP config");
    await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
    const lines = (await callTool(dataDir, "lister_onglets")).texte.split("\n");
    expect(lines.filter((l) => l.includes("vidola-a.localhost"))).toEqual(["site:vidola · Vidola · vidola-a.localhost · appli de site"]);
    expect(Object.values((await state(m)).onglets).filter((o) => o.url.includes("vidola-a.localhost"))).toEqual([]);
  });

  it("an agent extension's content script never runs in the app view, nor shows in its bar", async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
    profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
    const hote = "http://vidola-a.localhost/*";
    ecrireExtensionAgent(path.join(dataDir, "espace"), "cacheur", {
      "manifest.json": { manifest_version: 3, name: "Cacheur de l'agent", version: "1.0.0", content_scripts: [{ matches: [hote], css: ["cache.css"] }] },
      "cache.css": "#banniere { display: none !important; }\n",
    });
    grant(dataDir, "cacheur", { permissions: [], hotes: [hote], reseau: [], tousLesSites: false, scriptsTousLesSites: false, scripts: true });
    writeSite(dataDir, "vidola", { declaration: vidola() });
    w = await launchWithAmo({ dataDir, profile, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1" } });
    m = w.marionette;
    await resolveLocalHosts(m, HOSTS);
    await waitFor(m, `return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      return !!(await AddonManager.getAddonByID("cacheur@agent.webaios"))?.isActive;
    })();`, (v) => v === true, 30_000);
    // Witness: in a tab of the space, its sheet hides the banner.
    await inStore(`store.dispatch({ type: "ouvrirOnglet", fenetreId: store.state.fenetres[0].id, url: arguments[0] });`, [url("/pubs?onglet")]);
    await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (u) => u === url("/pubs?onglet"), 15_000);
    const inTab = () => inBrowser<string>(m, "gBrowser.selectedBrowser", "return getComputedStyle(document.getElementById('banniere')).display;").catch(() => null);
    await expect.poll(inTab, { timeout: 15_000 }).toBe("none");
    // The app view: never.
    await openAndWait();
    await new Promise((r) => setTimeout(r, 2000));
    expect(await view("getComputedStyle(document.getElementById('banniere')).display")).toBe("block");
    expect(await m.execute(`return ${siteWindowExpr("vidola")}.webaiosSiteWindow.addons.buttons().map((b) => b.id);`)).not.toContain("cacheur@agent.webaios");
  });
});
