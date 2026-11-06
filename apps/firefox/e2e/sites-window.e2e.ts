import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testActor } from "./agent-extensions";
import { dispatch, inWindow, pressClosing, state, waitFor, waitReady, windowHandles } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { inSiteBar, inSiteView, resolveLocalHosts, siteWindowCount, siteWindowExpr, startSitesServer, writeSite } from "./sites";
import { inUi, keyDown, keyUp, missingApi, pressKeys, waitUi } from "./ui";

// Plan 31 Task 3: the site app window and its bar, ports of Electron's e2e/sites.spec.ts (1, 2, 9, 10, 13, 14).

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";
const HOSTS = ["vidola-a.localhost", "pub.localhost", "compte.localhost"];
const BAR = 36;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let dataDir: string;
let profile: string;

const site = `${siteWindowExpr("vidola")}`;
const view = `${site}.gBrowser.selectedBrowser`;
const url = (p: string) => server.url("vidola-a.localhost", p);

async function launch(): Promise<void> {
  const actor = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1", ...actor.env }, prefs: actor.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, HOSTS);
}

/** In the chrome context, with `store` = the WebAiOs store. */
const inStore = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
/** « Ouvrir » on the app's row, as the Applications page sends it: through the host, which asks the chrome. */
const openSite = (id = "vidola") => inStore(`await store.agent.request("sites.agir", { id: arguments[0], action: "ouvrir", fenetre: store.state.fenetres[0].id });`, [id]);
const viewAt = (u: string, expr = view) =>
  waitFor(m, `const b = ${expr}; return !!b && b.currentURI.spec === ${JSON.stringify(u)} && !b.webProgress.isLoadingDocument;`, (v) => v === true, 15_000);
async function openAndWait(p = "/"): Promise<void> {
  await openSite();
  await viewAt(url(p));
}
/** Polls `body` in the bar's document (inSiteBar) until it returns a truthy value. */
async function waitBar<T = unknown>(body: string, args: unknown[] = [], ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await inSiteBar<T>(m, "vidola", `if (!doc.querySelector('[data-testid="barre-site"]')) return null; ${body}`, args);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting in the site bar on: ${body}`);
    await sleep(100);
  }
}
/** A trusted click (mousedown, mouseup) at the centre of a bar button. */
const barClick = (testid: string) =>
  waitBar(
    `const el = doc.querySelector('[data-testid="' + arguments[0] + '"]');
     if (!el) return false;
     const r = el.getBoundingClientRect();
     for (const type of ["mousedown", "mouseup"]) doc.defaultView.synthesizeMouseEvent(type, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1 });
     return true;`,
    [testid],
  );
const disabled = (testid: string) => waitBar<string>(`return String(doc.querySelector('[data-testid="' + arguments[0] + '"]').disabled);`, [testid]).then((v) => v === "true");
/** The bar's frame and the view, in the window's CSS pixels. */
const layout = () =>
  m.execute<{ bar: [number, number, string]; view: [number, number, number, number]; inner: [number, number] }>(
    `const win = ${site}; const f = win.document.getElementById("webaios-site-bar"); const fr = f.getBoundingClientRect(); const b = win.gBrowser.selectedBrowser.getBoundingClientRect();
     return { bar: [fr.top, fr.height, win.getComputedStyle(f).display], view: [b.top, b.left, b.width, b.height], inner: [win.innerWidth, win.innerHeight] };`,
  );
/** A WebDriver pointer click on `selector` in the app view, with `button` and the keys held. */
async function clickInView(selector: string, o: { button?: number; meta?: boolean } = {}): Promise<void> {
  const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  const handle = await m.execute<string>(`return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(${view});`);
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  try {
    const el = await m.command<{ value: Record<string, string> }>("WebDriver:FindElement", { using: "css selector", value: selector });
    const button = o.button ?? 0;
    const pointer = { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: el.value, x: 0, y: 0 }, { type: "pointerDown", button }, { type: "pointerUp", button }] };
    const keys = { type: "key", id: "keys", actions: o.meta ? [{ type: "keyDown", value: "" }, { type: "pause" }, { type: "pause" }, { type: "pause" }, { type: "keyUp", value: "" }] : [{ type: "pause" }] };
    await m.command("WebDriver:PerformActions", { actions: [keys, pointer] });
    await m.command("WebDriver:ReleaseActions");
  } finally {
    await m.setContext("chrome");
    await m.command("WebDriver:SwitchToWindow", { handle: main, focus: false });
  }
}
const browserWindows = () => m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].length;`);
const mainTabs = () => m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].filter((x) => x.document.documentElement.hasAttribute("webaios-main")).reduce((n, x) => n + x.gBrowser.tabs.length, 0);`);

beforeAll(async () => {
  server = await startSitesServer();
  const pub = (p: string) => server.url("pub.localhost", p);
  const d = (p: string, body: Parameters<typeof server.definir>[2]) => server.definir("vidola-a.localhost", p, body);
  d("/", `<title>Vidola A</title>
<a id="pub" href="${pub("/x")}">pub</a>
<a id="film" href="/film/2">film</a>`);
  d("/film/2", "<title>Film 2</title>");
  d("/plein", '<title>Plein</title><div id="plein" style="height:100px">vidéo</div>');
  d("/quitter", '<title>Quitter</title><script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; });</script>');
  d("/fichier", (_req, res) => res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="fichier.txt"' }).end("Bonjour"));
  server.definir("pub.localhost", "/x", "<title>Pub</title>");
  server.definir("compte.localhost", "/connexion", "<title>Connexion</title>");
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  const vidola = { nom: "Vidola", adresse: url("/"), domaines: ["vidola-a.localhost"], connexion: ["compte.localhost"] };
  // Written before the launch: the watcher sees no initial event that would reread the app on the way.
  writeSite(dataDir, "vidola", { declaration: vidola });
  writeSite(dataDir, "autre", { declaration: { ...vidola, nom: "Autre" } });
  await launch();
}, 90_000);
afterAll(async () => {
  await w?.close();
  await server?.fermer();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (profile) await rm(profile, { recursive: true, force: true });
});
beforeEach(() => void server.requetes.splice(0));
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await inStore(`for (const id of store.sites.openIds()) await store.sites.close(id);`).catch(() => {});
  }
});

describe("site app window", () => {
  it("opening without a home screen: the view shows the site, the bar shows « vidola-a.localhost »", async () => {
    await openAndWait();
    await waitBar(`return doc.querySelector('[data-testid="site-domaine"]')?.textContent === "vidola-a.localhost";`);
    expect(await inSiteBar(m, "vidola", `return doc.querySelector('[data-testid="site-nom"]').textContent;`)).toBe("Vidola");
    expect(await inSiteBar(m, "vidola", `return doc.querySelectorAll('[data-testid="site-accueil"]').length;`)).toBe(0);
    expect(await inSiteView(m, "vidola", "return document.title;")).toBe("Vidola A");
    // The window's title is the app's name, never the page's.
    expect(await m.execute(`return ${site}.document.title;`)).toBe("Vidola");
    const l = await layout();
    expect(l.bar.slice(0, 2)).toEqual([0, BAR]);
    expect(l.view).toEqual([BAR, 0, l.inner[0], l.inner[1] - BAR]);
    // The *.localhost host reached the loopback server, with its name.
    expect(server.requetes.some((r) => r.hote === "vidola-a.localhost" && r.chemin === "/")).toBe(true);
    // Firefox keeps its native title bar: no room left for the window buttons.
    expect(await inSiteBar(m, "vidola", `return doc.defaultView.getComputedStyle(doc.querySelector('[data-testid="barre-site"]')).paddingLeft;`)).toBe("8px");
  });

  it("reopening makes no second window and does not reload", async () => {
    await openAndWait();
    await inSiteView(m, "vidola", "window.marque = 42; return 1;");
    await openSite();
    await sleep(500);
    expect(await siteWindowCount(m, "vidola")).toBe(1);
    expect(await inSiteView(m, "vidola", "return window.marque;")).toBe(42);
  });

  it("the window's size and place are kept in <dataDir>/sites.json and taken back on reopening", async () => {
    await openAndWait();
    const frame = { x: 120, y: 90, largeur: 700, hauteur: 520 };
    await m.execute(`const win = ${site}; win.moveTo(arguments[0].x, arguments[0].y); win.resizeTo(arguments[0].largeur, arguments[0].hauteur);`, [frame]);
    await waitFor(m, `const win = ${site}; return [win.screenX, win.screenY, win.outerWidth, win.outerHeight].join();`, (v) => v === "120,90,700,520");
    await m.execute(`${site}.close();`);
    await waitFor(m, `return !${site};`, (v) => v === true);
    const file = path.join(dataDir, "sites.json");
    await expect.poll(() => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).vidola?.cadre : null), { timeout: 10_000 }).toEqual(frame);
    await openAndWait();
    expect(await m.execute(`const win = ${site}; return [win.screenX, win.screenY, win.outerWidth, win.outerHeight];`)).toEqual([120, 90, 700, 520]);
  });

  it("requestFullscreen of an element: the view takes the whole window; on exit the bar comes back", async () => {
    await openAndWait();
    await inSiteView(m, "vidola", "location.href = '/plein'; return 1;");
    await viewAt(url("/plein"));
    await inSiteView(m, "vidola", "void document.getElementById('plein').requestFullscreen(); return 1;", { gesture: true });
    await waitFor(m, `return !!${view}.browsingContext && ${site}.document.documentElement.hasAttribute("inDOMFullscreen");`, (v) => v === true);
    expect(await inSiteView(m, "vidola", "return !!document.fullscreenElement;")).toBe(true);
    await expect.poll(async () => {
      const l = await layout();
      return l.bar[2] === "none" && l.view[0] === 0 && l.view[3] === l.inner[1];
    }, { timeout: 10_000 }).toBe(true);
    // Without a gesture: the test's button is outside the fullscreen element, and exiting needs none.
    await inSiteView(m, "vidola", "void document.exitFullscreen(); return 1;");
    await waitFor(m, `return ${site}.document.documentElement.hasAttribute("inDOMFullscreen");`, (v) => v === false);
    await expect.poll(async () => {
      const l = await layout();
      return l.bar[2] === "block" && l.view[0] === BAR && l.view[3] === l.inner[1] - BAR;
    }, { timeout: 10_000 }).toBe(true);
  });

  it("back, forward and reload in the bar act on the site view", async () => {
    await openAndWait();
    await waitBar(`return !!doc.querySelector('[data-testid="site-precedent"]');`);
    expect(await disabled("site-precedent")).toBe(true);
    // With a gesture: a page left without one may be skipped by back.
    await inSiteView(m, "vidola", "location.href = '/film/2'; return 1;", { gesture: true });
    await viewAt(url("/film/2"));
    await waitBar(`return !doc.querySelector('[data-testid="site-precedent"]').disabled;`);
    await barClick("site-precedent");
    await viewAt(url("/"));
    await waitBar(`return !doc.querySelector('[data-testid="site-suivant"]').disabled;`);
    await barClick("site-suivant");
    await viewAt(url("/film/2"));
    await inSiteView(m, "vidola", "window.marque = 1; return 1;");
    await barClick("site-recharger");
    await expect.poll(() => inSiteView(m, "vidola", "return window.marque === undefined && document.readyState === 'complete';").catch(() => false), { timeout: 10_000 }).toBe(true);
  });

  it("a cookie set by the app is only in its container; no history, no tab", async () => {
    await openSite("autre");
    await viewAt(url("/"), `${siteWindowExpr("autre")}.gBrowser.selectedBrowser`);
    await openAndWait();
    await inSiteView(m, "vidola", "location.href = '/cookie'; return 1;");
    await viewAt(url("/cookie"));
    const cookies = (container: string | null) =>
      inStore<string[]>(
        `const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
         const userContextId = arguments[0] === null ? 0 : ContextualIdentityService.getPrivateIdentity(arguments[0])?.userContextId;
         if (userContextId === undefined) return ["no container " + arguments[0]];
         return Services.cookies.getCookiesFromHost("vidola-a.localhost", { userContextId }).map((c) => c.name + "=" + c.value);`,
        [container],
      );
    await expect.poll(() => cookies("userContextIdInternal.webaios-site-vidola")).toContain("essai=vidola-a.localhost");
    // A login profile's container (Electron's persist:app-x stand-in) and the default one.
    await inStore(`store.containerFor("profil-essai");`);
    for (const c of [null, "userContextIdInternal.webaios-site-autre", "userContextIdInternal.webaios-profil-essai"]) expect(await cookies(c), String(c)).toEqual([]);
    await sleep(2000);
    expect(await inUi(m, "return await ui.webaios.historique.rechercher('vidola', 50, false);")).toEqual([]);
    expect(Object.values((await state(m)).onglets).some((o) => o.url.includes("vidola"))).toBe(false);
  });

  it("⌘W closes the site window without a question", async () => {
    const before = await windowHandles(m);
    await openSite();
    await viewAt(url("/"));
    const handle = (await windowHandles(m)).find((h) => !before.includes(h))!;
    await inSiteView(m, "vidola", "location.href = '/quitter'; return 1;");
    await viewAt(url("/quitter"));
    // The page's beforeunload asks only after a user activation.
    await inSiteView(m, "vidola", "return 1;", { gesture: true });
    await inWindow(m, handle, () => pressClosing(m, "Meta+w"));
    await waitFor(m, `return !${site};`, (v) => v === true);
    expect(await windowHandles(m)).toEqual(before);
  });

  it("a download in the app is cancelled", async () => {
    const dl = path.join(dataDir, "dl");
    await mkdir(dl, { recursive: true });
    await m.execute(`Services.prefs.setIntPref("browser.download.folderList", 2); Services.prefs.setStringPref("browser.download.dir", arguments[0]);`, [dl]);
    await openAndWait();
    await inSiteView(m, "vidola", "location.href = '/fichier'; return 1;");
    await expect.poll(() => server.requetes.some((r) => r.chemin === "/fichier")).toBe(true);
    await sleep(1500);
    expect(await inUi(m, "return (await ui.webaios.telechargements.liste()).length;")).toBe(0);
    expect(await m.execute(`return (async () => { const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs"); return (await (await Downloads.getList(Downloads.ALL)).getAll()).length; })();`)).toBe(0);
    expect(readdirSync(dl)).toEqual([]);
  });

  it("the site window is never a WebAiOs window", async () => {
    const f = (await state(m)).fenetres[0]!;
    // ⌃Tab needs two tabs to walk.
    for (const u of [server.url("compte.localhost", "/connexion"), server.url("pub.localhost", "/x")]) await dispatch(m, { type: "ouvrirOnglet", fenetreId: f.id, url: u });
    const tabs = await mainTabs();
    await openAndWait();
    expect((await state(m)).fenetres.map((x) => x.id)).toEqual([f.id]);
    expect(await m.execute(`const win = ${site}; return [!!win.webaiosWindow, win.document.documentElement.hasAttribute("webaios-main")];`)).toEqual([false, false]);
    await m.execute(`${site}.focus();`);
    await sleep(300);
    expect(await inStore(`return store.windows.active();`)).toBe(f.id);
    // ⌃Tab in the main window walks its tabs only.
    await keyDown(m, "Control");
    await pressKeys(m, "Tab");
    await waitUi(m, `return !!doc.querySelector('[data-testid="panneau-onglets"]');`);
    const cards = await inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="panneau-onglets"] [data-testid="carte-onglet"]')].map((c) => c.textContent);`);
    await keyUp(m, "Control");
    expect(cards.some((t) => /vidola/i.test(t))).toBe(false);
    expect(await mainTabs()).toBe(tabs);
  });

  it("closing the app window closes its sign-in windows, never a main window in its container", async () => {
    await openAndWait();
    // A main window showing a page of the app's container (what a ⌘click tab once made, before TabSync swaps it): its
    // selected browser carries the container, the attribute the old closing rule read.
    await m.execute(
      `const b = gBrowser.selectedBrowser;
       b.setAttribute("webaios-test-usercontextid", b.getAttribute("usercontextid") ?? "");
       b.setAttribute("usercontextid", ${view}.getAttribute("usercontextid"));`,
    );
    try {
      await inStore(`store.sites.routeOpen("vidola", arguments[0]);`, [server.url("compte.localhost", "/connexion")]);
      const small = `[...Services.wm.getEnumerator("navigator:browser")].find((x) => x.document.documentElement.getAttribute("webaios-site-small") === "vidola")`;
      await waitFor(m, `return !!${small};`, (v) => v === true);
      const before = await browserWindows();
      // The scenario holds: the main window shows its tab in the app's container.
      expect(await m.execute(`return gBrowser.selectedBrowser.getAttribute("usercontextid") === ${view}.getAttribute("usercontextid");`)).toBe(true);
      await m.execute(`${site}.close();`);
      await waitFor(m, `return !${site} && !${small};`, (v) => v === true);
      await sleep(500);
      expect(await browserWindows()).toBe(before - 2);
      expect(await m.execute(`return !!window.webaiosWindow && !window.closed;`)).toBe(true);
    } finally {
      await m.execute(
        `const b = gBrowser.selectedBrowser; const was = b.getAttribute("webaios-test-usercontextid");
         if (was) b.setAttribute("usercontextid", was); else b.removeAttribute("usercontextid");
         b.removeAttribute("webaios-test-usercontextid");`,
      ).catch(() => {});
    }
  });

  it("⌘click and middle click on a link of the app never open a tab of the main window", async () => {
    await openAndWait();
    const tabs = await mainTabs();
    const onglets = Object.keys((await state(m)).onglets).length;
    // Every tab opened in any browser window meanwhile, even one the guard closes at once.
    await m.execute(
      `window.webaiosTestOpened = [];
       for (const x of Services.wm.getEnumerator("navigator:browser"))
         x.gBrowser.tabContainer.addEventListener("TabOpen", () => window.webaiosTestOpened.push(x.document.documentElement.hasAttribute("webaios-site") ? "site" : "other"));`,
    );
    // On the site: the app view goes there.
    await clickInView("#film", { button: 1 });
    await viewAt(url("/film/2"));
    await inSiteView(m, "vidola", "history.back(); return 1;");
    await viewAt(url("/"));
    // Off the site: blocked, no request.
    await clickInView("#pub", { meta: true });
    await expect.poll(() => inStore<string[]>(`return store.sites.blocked("vidola").slice();`)).toContain("pub.localhost");
    await sleep(500);
    expect(server.requetes.filter((r) => r.hote === "pub.localhost")).toEqual([]);
    expect(await m.execute(`return ${view}.currentURI.spec;`)).toBe(url("/"));
    expect(await m.execute(`return ${site}.gBrowser.tabs.length;`)).toBe(1);
    expect(await mainTabs()).toBe(tabs);
    expect(Object.keys((await state(m)).onglets).length).toBe(onglets);
    expect(await m.execute(`return window.webaiosTestOpened;`)).toEqual([]);
  });

  // Last: it restarts the browser.
  it("quitting with a site window open restores only the main window", { timeout: 90_000 }, async () => {
    await openAndWait();
    await w.close();
    await launch();
    await sleep(1000);
    expect(await browserWindows()).toBe(1);
    expect(await m.execute(`return document.documentElement.hasAttribute("webaios-main");`)).toBe(true);
    expect(await siteWindowCount(m, "vidola")).toBe(0);
    const s = await state(m);
    expect(s.fenetres).toHaveLength(1);
    expect(Object.values(s.onglets).some((o) => o.url.includes("vidola"))).toBe(false);
  });
});
