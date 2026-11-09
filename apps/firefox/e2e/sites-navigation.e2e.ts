import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testActor } from "./agent-extensions";
import { inWindow, newWindow, state, waitFor, waitReady, windowHandles } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { inBrowser, inSiteBar, inSiteView, resolveLocalHosts, siteWindowExpr, startSitesServer, writeSite } from "./sites";
import { missingApi, pressKeys } from "./ui";

// Plan 31 Task 4: navigation kept on the app's domains, the sign-in window, permissions and « Ouvrir dans un onglet »,
// plus the plan's Review Focus 4.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";
const HOSTS = ["vidola-a.localhost", "vidola-b.localhost", "pub.localhost", "autre-pub.localhost", "compte.localhost"];
const META = "";
const ALT = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let dataDir: string;
let profile: string;

const site = siteWindowExpr("vidola");
const view = `${site}.gBrowser.selectedBrowser`;
const url = (p: string) => server.url("vidola-a.localhost", p);
const pub = (p: string) => server.url("pub.localhost", p);
const login = () => server.url("compte.localhost", "/connexion");
const small = `[...Services.wm.getEnumerator("navigator:browser")].find((x) => x.document.documentElement.getAttribute("webaios-site-small") === "vidola")`;
const vidola = () => ({ name: "Vidola", url: url("/"), domains: ["vidola-a.localhost"], login: ["compte.localhost"] });
/** What reached pub.localhost during this test, the home page's ad frame aside. */
const nothingToPub = () => server.requests.filter((r) => r.host === "pub.localhost" && r.path !== "/cadre").map((r) => r.path);

const inStore = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
/** « Ouvrir » on the app's row, as the Applications page sends it: through the host, which rereads site.json. */
const openSite = (id = "vidola") => inStore(`await store.agent.request("sites.agir", { id: arguments[0], action: "ouvrir", fenetre: store.state.fenetres[0]?.id ?? null });`, [id]);
const viewAt = (u: string, expr = view) =>
  waitFor(m, `const b = ${expr}; return !!b && b.currentURI.spec === ${JSON.stringify(u)} && !b.webProgress.isLoadingDocument;`, (v) => v === true, 15_000);
const viewUrl = () => m.execute<string>(`return ${view}.currentURI.spec;`);
async function openAndWait(id = "vidola", p = "/"): Promise<void> {
  await openSite(id);
  await viewAt(url(p), `${siteWindowExpr(id)}.gBrowser.selectedBrowser`);
}
async function waitBar<T = unknown>(body: string, id = "vidola", ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await inSiteBar<T>(m, id, `if (!doc.querySelector('[data-testid="barre-site"]')) return null; ${body}`);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting in the site bar on: ${body}`);
    await sleep(100);
  }
}
/** Waits for the bar's « Lien vers <host> bloqué ». */
const waitNotice = (host: string, id = "vidola") =>
  waitBar(`return doc.querySelector('[data-testid="site-avis"]')?.textContent.includes(${JSON.stringify(`Lien vers ${host} bloqué`)});`, id);
const noticeCount = () => inSiteBar<number>(m, "vidola", `return doc.querySelectorAll('[data-testid="site-avis"]').length;`);
const barClick = (testid: string) =>
  waitBar(
    `const el = doc.querySelector('[data-testid="${testid}"]');
     if (!el) return false;
     const r = el.getBoundingClientRect();
     for (const type of ["mousedown", "mouseup"]) doc.defaultView.synthesizeMouseEvent(type, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1 });
     return true;`,
  );
/** A WebDriver pointer click on `selector` in the app view, with `key` held. */
async function clickInView(selector: string, key: string): Promise<void> {
  const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  const handle = await m.execute<string>(`return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(${view});`);
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  try {
    const el = await m.command<{ value: Record<string, string> }>("WebDriver:FindElement", { using: "css selector", value: selector });
    const pointer = { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: el.value, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] };
    const keys = { type: "key", id: "keys", actions: [{ type: "keyDown", value: key }, { type: "pause" }, { type: "pause" }, { type: "pause" }, { type: "keyUp", value: key }] };
    await m.command("WebDriver:PerformActions", { actions: [keys, pointer] });
    await m.command("WebDriver:ReleaseActions");
  } finally {
    await m.setContext("chrome");
    await m.command("WebDriver:SwitchToWindow", { handle: main, focus: false });
  }
}
const browserWindows = () => m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].length;`);
const tabUrls = async () => Object.values((await state(m)).tabs).map((o) => o.url);
/** Counts every tab opened in any browser window from now on (window.webaiosTestOpened), even one closed at once. */
const countTabOpens = () =>
  m.execute(
    `window.webaiosTestOpened = [];
     for (const x of Services.wm.getEnumerator("navigator:browser"))
       x.gBrowser.tabContainer.addEventListener("TabOpen", () => window.webaiosTestOpened.push(x.document.documentElement.hasAttribute("webaios-site") ? "site" : "other"));`,
  );

beforeAll(async () => {
  server = await startSitesServer();
  const d = (p: string, body: Parameters<typeof server.define>[2]) => server.define("vidola-a.localhost", p, body);
  d("/", `<title>Vidola A</title>
<a id="pub" href="${pub("/x")}">pub</a>
<a id="aller-pub" href="/aller-pub">aller</a>
<a id="film" href="/film/2" target="_blank">film</a>
<a id="film-ici" href="/film/2">film ici</a>
<iframe id="cadre" src="${pub("/cadre")}"></iframe>`);
  d("/aller-pub", (_req, res) => res.writeHead(302, { Location: pub("/arrivee") }).end());
  d("/film/2", "<title>Film 2</title>");
  d("/audio", '<title>Audio</title><audio id="a" autoplay src="/son.wav"></audio>');
  d("/son.wav", (_req, res) => res.writeHead(200, { "Content-Type": "audio/wav" }).end(silenceWav()));
  d("/refresh", `<title>Refresh</title><meta http-equiv="refresh" content="0;url=${pub("/meta")}">`);
  d("/formulaire", `<title>Formulaire</title><form id="f" method="post" action="${pub("/post")}"><input name="q" value="secret"><button id="envoyer">ok</button></form>`);
  server.define("pub.localhost", "/x", "<title>Pub</title>");
  server.define("pub.localhost", "/cadre", "<title>Cadre pub</title><p>pub</p>");
  server.define("pub.localhost", "/arrivee", "<title>Arrivée pub</title>");
  server.define("compte.localhost", "/connexion", "<title>Connexion</title>");
  server.define("vidola-b.localhost", "/", "<title>Vidola B</title>");
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  writeSite(dataDir, "vidola", { declaration: vidola() });
  writeSite(dataDir, "deux", { declaration: { ...vidola(), name: "Deux", domains: ["vidola-a.localhost", "vidola-b.localhost"] } });
  const actor = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_LOCAL_ADDRESSES: "1", ...actor.env }, prefs: actor.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, HOSTS);
}, 90_000);
afterAll(async () => {
  await w?.close();
  await server?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (profile) await rm(profile, { recursive: true, force: true });
});
beforeEach(() => void server.requests.splice(0));
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await inStore(`for (const id of store.sites.openIds()) await store.sites.close(id);`).catch(() => {});
    await m.execute(`for (const x of [...Services.wm.getEnumerator("navigator:browser")]) if (x.document.documentElement.hasAttribute("webaios-site-small")) x.close();`).catch(() => {});
  }
});

/** A short silent WAV. */
function silenceWav(): Buffer {
  const rate = 8000;
  const samples = rate;
  const b = Buffer.alloc(44 + samples);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples, 40);
  b.fill(128, 44);
  return b;
}

describe("site app navigation", () => {
  it("a link to pub.localhost is not followed: « Lien vers pub.localhost bloqué », no tab; « Ouvrir dans un onglet » opens one", async () => {
    await openAndWait();
    const before = await tabUrls();
    await inSiteView(m, "vidola", "document.getElementById('pub').click(); return 1;", { gesture: true });
    await waitNotice("pub.localhost");
    expect(await viewUrl()).toBe(url("/"));
    expect(await tabUrls()).toEqual(before);
    expect(server.requests.some((r) => r.host === "pub.localhost" && r.path === "/x")).toBe(false);
    await barClick("site-ouvrir-onglet");
    await expect.poll(tabUrls, { timeout: 10_000 }).toContain(pub("/x"));
    // The mention falls.
    await waitBar(`return doc.querySelectorAll('[data-testid="site-avis"]').length === 0;`);
  });

  it("ten window.open to pub.localhost from the page and from a pub.localhost frame: no tab, no window more", async () => {
    await openAndWait();
    await expect.poll(() => inSiteView(m, "vidola", "return document.title;", { frame: 0 }), { timeout: 10_000 }).toBe("Cadre pub");
    const tabs = await tabUrls();
    const windows = await browserWindows();
    const ten = `for (let i = 0; i < 10; i++) window.open(${JSON.stringify(pub("/x"))} + "?n=" + i); return 1;`;
    await inSiteView(m, "vidola", ten, { gesture: true });
    await inSiteView(m, "vidola", ten, { gesture: true, frame: 0 });
    await inSiteView(m, "vidola", "window.open('about:blank'); window.open(''); return 1;", { gesture: true });
    await waitNotice("pub.localhost");
    await sleep(1000);
    expect(await browserWindows()).toBe(windows);
    expect(await tabUrls()).toEqual(tabs);
    expect(server.requests.some((r) => r.host === "pub.localhost" && r.path.startsWith("/x"))).toBe(false);
    expect(await noticeCount()).toBe(1);
  });

  it("target=_blank to /film/2: the app view goes there", async () => {
    await openAndWait();
    const windows = await browserWindows();
    await inSiteView(m, "vidola", "document.getElementById('film').click(); return 1;", { gesture: true });
    await viewAt(url("/film/2"));
    expect(await browserWindows()).toBe(windows);
  });

  it("window.open to the sign-in domain: a 500 × 650 window in the app's container, kept on its domains, opening nothing", async () => {
    await openAndWait();
    await inSiteView(m, "vidola", `window.open(${JSON.stringify(login())}, "connexion", "width=500,height=650"); return 1;`, { gesture: true });
    const info = () =>
      m.execute(`const x = ${small}; if (!x) return null; const b = x.gBrowser.selectedBrowser;
        return { sameContainer: b.getAttribute("usercontextid") === ${view}.getAttribute("usercontextid"), url: b.currentURI.spec, width: x.outerWidth, toolbar: x.toolbar.visible };`);
    await expect.poll(info, { timeout: 10_000 }).toEqual({ sameContainer: true, url: login(), width: 500, toolbar: false });
    const smallBrowser = `(${small}).gBrowser.selectedBrowser`;
    await waitFor(m, `return !${smallBrowser}.webProgress.isLoadingDocument;`, (v) => v === true);
    // It opens nothing: neither the site (the app view stays) nor another sign-in window.
    const windows = await browserWindows();
    await inBrowser(m, smallBrowser, `window.open(${JSON.stringify(url("/film/2"))}); window.open(${JSON.stringify(login())}, "x", "width=400,height=400"); return 1;`, { gesture: true });
    await sleep(800);
    expect(await browserWindows()).toBe(windows);
    expect(await viewUrl()).toBe(url("/"));
    expect(server.requests.some((r) => r.path === "/film/2")).toBe(false);
    // Its navigation stays on the site and its sign-in domains.
    await inBrowser(m, smallBrowser, `location.href = ${JSON.stringify(pub("/x"))}; return 1;`);
    await sleep(800);
    expect(await info()).not.toBeNull();
    expect(server.requests.some((r) => r.host === "pub.localhost" && r.path === "/x")).toBe(false);
  });

  it("a server redirect of /aller-pub (clicked link) to pub.localhost: blocked, « Lien vers pub.localhost bloqué »", async () => {
    await openAndWait();
    const tabs = await tabUrls();
    await inSiteView(m, "vidola", "document.getElementById('aller-pub').click(); return 1;", { gesture: true });
    await waitNotice("pub.localhost");
    expect(server.requests.some((r) => r.host === "vidola-a.localhost" && r.path === "/aller-pub")).toBe(true);
    expect(server.requests.some((r) => r.host === "pub.localhost" && r.path === "/arrivee")).toBe(false);
    expect(await tabUrls()).toEqual(tabs);
    // A new page: the mention falls.
    await inSiteView(m, "vidola", "document.getElementById('film-ici').click(); return 1;", { gesture: true });
    await viewAt(url("/film/2"));
    await waitBar(`return doc.querySelectorAll('[data-testid="site-avis"]').length === 0;`);
  });

  it("a page with <audio autoplay> plays without a gesture; a notification request is refused without a question", async () => {
    await openAndWait();
    await inSiteView(m, "vidola", "location.href = '/audio'; return 1;");
    // Its media keeps the document loading for a while: only the address is waited for.
    await waitFor(m, `return ${view}.currentURI.spec;`, (v) => v === url("/audio"));
    // As permissions.e2e.ts: a headless window never comes to the foreground, where Firefox starts allowed media
    // (media.block-autoplay-until-in-foreground), so the policy and the absence of a refusal are what count.
    const [policy, muted, played] = await inSiteView<[string, boolean, string]>(
      m,
      "vidola",
      `const a = document.getElementById("a"); return Promise.race([a.play().then(() => "played", (e) => e.name), new Promise((ok) => setTimeout(() => ok("pending"), 1500))]).then((r) => [navigator.getAutoplayPolicy(a), a.muted, r]);`,
    );
    expect([policy, muted]).toEqual(["allowed", false]);
    expect(["played", "pending"]).toContain(played);
    // Refused without a question: Firefox's cancelled request, not remembered, answers "default" (as an invisible read's,
    // permissions.e2e.ts).
    expect(await inSiteView(m, "vidola", "return Notification.requestPermission();", { gesture: true })).toBe("default");
    expect(await inSiteView(m, "vidola", "return Notification.permission;")).toBe("default");
    await sleep(500);
    const asked = await m.execute(
      `return [...Services.wm.getEnumerator("navigator:browser")].map((x) => ({ banner: !!x.document.querySelector('[data-testid="demande-permission"]')?.checkVisibility(), firefox: x.PopupNotifications._currentNotifications.map((n) => n.id) }));`,
    );
    for (const a of asked as unknown[]) expect(a).toEqual({ banner: false, firefox: [] });
  });

  it("a pub.localhost frame doing top.location to pub.localhost (with a gesture): blocked, mention, no request", async () => {
    await openAndWait();
    await expect.poll(() => inSiteView(m, "vidola", "return document.title;", { frame: 0 }), { timeout: 10_000 }).toBe("Cadre pub");
    server.requests.splice(0);
    await inSiteView(m, "vidola", `top.location = ${JSON.stringify(pub("/haut"))}; return 1;`, { gesture: true, frame: 0 });
    await waitNotice("pub.localhost");
    await sleep(500);
    expect(await viewUrl()).toBe(url("/"));
    expect(nothingToPub()).toEqual([]);
  });

  it("a <meta refresh> to pub.localhost: blocked, mention, no request", async () => {
    await openAndWait();
    await inSiteView(m, "vidola", "location.href = '/refresh'; return 1;", { gesture: true });
    await waitNotice("pub.localhost");
    await sleep(500);
    expect(await viewUrl()).toBe(url("/refresh"));
    expect(nothingToPub()).toEqual([]);
  });

  it("a form POST to pub.localhost: blocked, mention, no request", async () => {
    await openAndWait();
    await inSiteView(m, "vidola", "location.href = '/formulaire'; return 1;", { gesture: true });
    await viewAt(url("/formulaire"));
    await inSiteView(m, "vidola", "document.getElementById('envoyer').click(); return 1;", { gesture: true });
    await waitNotice("pub.localhost");
    await sleep(500);
    expect(await viewUrl()).toBe(url("/formulaire"));
    expect(nothingToPub()).toEqual([]);
  });

  // Firefox itself refuses opener.location from the sign-in window (SecurityError, spike (b)): nothing to mention.
  it("the sign-in window doing opener.location to pub.localhost: the view stays on the site, no request", async () => {
    await openAndWait();
    await inSiteView(m, "vidola", `window.open(${JSON.stringify(login())}, "connexion", "width=500,height=650"); return 1;`, { gesture: true });
    const smallBrowser = `(${small}).gBrowser.selectedBrowser`;
    await waitFor(m, `const x = ${small}; return !!x && x.gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(login())} && !x.gBrowser.selectedBrowser.webProgress.isLoadingDocument;`, (v) => v === true);
    expect(await inBrowser(m, smallBrowser, "return !!window.opener;")).toBe(true);
    // From the page world, with a gesture.
    const code = `try { opener.location = ${JSON.stringify(pub("/opener"))}; document.documentElement.dataset.r = "assigned"; } catch (e) { document.documentElement.dataset.r = e.name; }`;
    await inBrowser(m, smallBrowser, `const s = document.createElement("script"); s.textContent = ${JSON.stringify(code)}; document.documentElement.append(s); s.remove(); return 1;`, { gesture: true });
    expect(await inBrowser(m, smallBrowser, "return document.documentElement.dataset.r;")).toBe("SecurityError");
    await sleep(500);
    expect(await viewUrl()).toBe(url("/"));
    expect(nothingToPub()).toEqual([]);
  });

  it("back to a domain removed from site.json since the visit: blocked, « Lien vers vidola-b.localhost bloqué »", async () => {
    const two = `${siteWindowExpr("deux")}.gBrowser.selectedBrowser`;
    await openAndWait("deux");
    await inSiteView(m, "deux", `location.href = ${JSON.stringify(server.url("vidola-b.localhost", "/"))}; return 1;`, { gesture: true });
    await viewAt(server.url("vidola-b.localhost", "/"), two);
    await inSiteView(m, "deux", `location.href = ${JSON.stringify(url("/film/2"))}; return 1;`, { gesture: true });
    await viewAt(url("/film/2"), two);
    // The agent removes vidola-b from site.json; the app is opened again (same window, new rules).
    writeSite(dataDir, "deux", { declaration: { ...vidola(), name: "Deux" } });
    await openSite("deux");
    await waitBar(`return !doc.querySelector('[data-testid="site-precedent"]').disabled;`, "deux");
    server.requests.splice(0);
    await inSiteBar(m, "deux",
      `const el = doc.querySelector('[data-testid="site-precedent"]'); const r = el.getBoundingClientRect();
       for (const type of ["mousedown", "mouseup"]) doc.defaultView.synthesizeMouseEvent(type, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1 });`);
    await waitNotice("vidola-b.localhost", "deux");
    await sleep(500);
    expect(await m.execute(`return ${two}.currentURI.spec;`)).toBe(url("/film/2"));
    expect(server.requests.filter((r) => r.host === "vidola-b.localhost")).toEqual([]);
    writeSite(dataDir, "deux", { declaration: { ...vidola(), name: "Deux", domains: ["vidola-a.localhost", "vidola-b.localhost"] } });
  });

  it("window.open bursts to two alternated domains: at most one change of the mention per 500 ms", async () => {
    await openAndWait();
    await waitBar(`return true;`);
    // Every state the controller sends to the bar.
    await m.execute(`const win = ${site}; win.webaiosTestSent = 0; win.webaiosSiteWindow.onState(() => win.webaiosTestSent++);`);
    const a = JSON.stringify(pub("/x"));
    const b = JSON.stringify(server.url("autre-pub.localhost", "/x"));
    await inSiteView(m, "vidola", `for (let i = 0; i < 20; i++) window.open(i % 2 ? ${a} : ${b}); return 1;`, { gesture: true });
    await waitNotice("pub.localhost");
    await sleep(1200);
    const sent = await m.execute<number>(`return ${site}.webaiosTestSent;`);
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(sent).toBeLessThanOrEqual(3);
    await waitNotice("pub.localhost");
  });

  it("loads in the app view that are not http(s) are refused: file: (⌘O, a dropped file), mailto:, an external scheme, blob:", async () => {
    await openAndWait();
    await expect.poll(() => inSiteView(m, "vidola", "return document.title;", { frame: 0 }), { timeout: 10_000 }).toBe("Cadre pub");
    await inSiteView(m, "vidola", "window.marque = 7; return 1;");
    // What would launch the OS handler (Firefox's content dispatch chooser) records instead.
    await m.execute(
      `const reg = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
       const contract = "@mozilla.org/content-dispatch-chooser;1";
       window.webaiosTestChooser = { cid: reg.contractIDToCID(contract), mine: Services.uuid.generateUUID(), seen: [] };
       const chooser = { QueryInterface: ChromeUtils.generateQI(["nsIContentDispatchChooser"]), handleURI: (_h, uri) => void window.webaiosTestChooser.seen.push(uri.spec) };
       window.webaiosTestChooser.factory = { QueryInterface: ChromeUtils.generateQI(["nsIFactory"]), createInstance: (iid) => chooser.QueryInterface(iid) };
       reg.registerFactory(window.webaiosTestChooser.mine, "test chooser", contract, window.webaiosTestChooser.factory);`,
    );
    // Each vector is checked on its own: one that gets through is reported, and the view is put back on the site.
    const stays = async (what: string) => {
      await sleep(600);
      const at = await viewUrl();
      expect.soft(at, what).toBe(url("/"));
      if (at === url("/")) return void expect.soft(await inSiteView(m, "vidola", "return window.marque;"), what).toBe(7);
      await m.execute(`${view}.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [url("/")]);
      await viewAt(url("/"));
      await expect.poll(() => inSiteView(m, "vidola", "return document.title;", { frame: 0 }), { timeout: 10_000 }).toBe("Cadre pub");
      await inSiteView(m, "vidola", "window.marque = 7; return 1;");
    };
    try {
      const file = "file://" + path.join(dataDir, "sites", "vidola", "site.json");
      const system = "Services.scriptSecurityManager.getSystemPrincipal()";
      await m.execute(`${site}.openLinkIn(arguments[0], "current", { triggeringPrincipal: ${system} }); return 1;`, [file]);
      await stays("⌘O file:");
      await m.execute(`${view}.droppedLinkHandler(null, [{ url: arguments[0], name: "", type: "" }], ${system}); return 1;`, [file]);
      await stays("dropped file:");
      for (const target of ["mailto:a@b.test", "zoommtg://join?x=1"]) {
        await inSiteView(m, "vidola", `location.href = ${JSON.stringify(target)}; return 1;`, { gesture: true });
        await stays(target);
      }
      expect.soft(await m.execute(`return window.webaiosTestChooser.seen;`), "OS handler").toEqual([]);
      await inSiteView(m, "vidola", "location.href = URL.createObjectURL(new Blob(['<title>blob</title>'], { type: 'text/html' })); return 1;", { gesture: true });
      await stays("blob:");
      // From the pub.localhost frame (cross-origin), its own blob: as top.location.
      await inSiteView(m, "vidola", "top.location = URL.createObjectURL(new Blob(['<title>blob</title>'], { type: 'text/html' })); return 1;", { gesture: true, frame: 0 });
      await stays("blob: from a cross-origin frame");
    } finally {
      await m.execute(
        `const reg = Components.manager.QueryInterface(Ci.nsIComponentRegistrar); const t = window.webaiosTestChooser;
         reg.unregisterFactory(t.mine, t.factory); reg.registerFactory(t.cid, "", "@mozilla.org/content-dispatch-chooser;1", null);`,
      );
    }
    // Firefox's own error page still shows for a site address that cannot be reached.
    const closed = url("/").replace(/:\d+\//, ":59999/");
    await inSiteView(m, "vidola", `location.href = ${JSON.stringify(closed)}; return 1;`, { gesture: true });
    await waitFor(m, `return String(${view}.browsingContext.currentWindowGlobal?.documentURI?.spec ?? "");`, (v) => String(v).startsWith("about:neterror"), 15_000);
  });

  it("Alt+click (Firefox's « save link ») does nothing in the app", async () => {
    await m.execute(`Services.prefs.setBoolPref("browser.altClickSave", true);`);
    try {
      await openAndWait();
      await clickInView("#film-ici", ALT);
      await clickInView("#pub", ALT);
      await sleep(800);
      expect(await viewUrl()).toBe(url("/"));
      expect(server.requests.filter((r) => r.path === "/film/2" || r.host === "pub.localhost").map((r) => r.path).filter((c) => c !== "/cadre")).toEqual([]);
      expect(await noticeCount()).toBe(0);
    } finally {
      await m.execute(`Services.prefs.clearUserPref("browser.altClickSave");`);
    }
  });

  it("the app window is at least 360 × 240", async () => {
    await openAndWait();
    await m.execute(`${site}.resizeTo(100, 100);`);
    await sleep(800);
    const [width, height] = await m.execute<[number, number]>(`const x = ${site}; return [x.outerWidth, x.outerHeight];`);
    expect(width).toBeGreaterThanOrEqual(360);
    expect(height).toBeGreaterThanOrEqual(240);
  });

  it("reopened before the closed window unloads: the new app's sign-in window stays", async () => {
    await openAndWait();
    // The old window's unload is held until the new app's sign-in window is set up.
    const kept = await m.execute<boolean>(
      `return (async () => {
        const sites = ChromeUtils.importESModule("${STORE}").sites;
        const old = sites.windowOf("vidola");
        const site = sites.siteOf("vidola");
        const marked = () => [...Services.wm.getEnumerator("navigator:browser")].some((x) => x.document.documentElement.getAttribute("webaios-site-small") === "vidola");
        old.addEventListener("unload", () => { const end = Date.now() + 5000; Services.tm.spinEventLoopUntil("webaios test", () => marked() || Date.now() > end); }, true);
        old.close();
        sites.open(site);
        sites.routeOpen("vidola", arguments[0]);
        for (let i = 0; i < 50 && !old.closed; i++) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 1000));
        return marked();
      })();`,
      [login()],
    );
    expect(kept).toBe(true);
    await viewAt(url("/"));
  });

  it("Open in a tab targets the last main window; Firefox tab commands are inert in the app", { timeout: 60_000 }, async () => {
    const first = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    const second = await newWindow(m);
    const idOf = (h: string) => inWindow(m, h, () => m.execute<string>(`return window.webaiosWindow.fenetreId;`));
    const ids = { [first]: await idOf(first), [second]: await idOf(second) };
    const before = new Set(await windowHandles(m));
    await openAndWait();
    const app = (await windowHandles(m)).find((h) => !before.has(h))!;
    for (const target of [second, first]) {
      // That main window was the last one in front, then the app came in front.
      await inWindow(m, target, () => m.execute(`window.focus();`));
      await sleep(300);
      await m.execute(`${site}.focus();`);
      await sleep(300);
      await inSiteView(m, "vidola", "document.getElementById('pub').click(); return 1;", { gesture: true });
      await waitNotice("pub.localhost");
      await barClick("site-ouvrir-onglet");
      const s = await expect.poll(async () => Object.values((await state(m)).tabs).find((o) => o.url === pub("/x") && o.windowId === ids[target]), { timeout: 10_000 }).toBeTruthy().then(() => state(m));
      const tab = Object.values(s.tabs).find((o) => o.url === pub("/x") && o.windowId === ids[target])!;
      // In that window's active space.
      expect(tab.spaceId).toBe(s.windows.find((f) => f.id === ids[target])!.activeSpace);
      for (const o of Object.values(s.tabs)) if (o.url === pub("/x")) await inStore(`store.dispatch({ type: "fermerOnglet", id: arguments[0] });`, [o.id]);
    }
    // Firefox's tab, address and history keys in the app: no tab anywhere, the view does not move, the bar stays the way.
    await inSiteView(m, "vidola", "document.getElementById('film-ici').click(); return 1;", { gesture: true });
    await viewAt(url("/film/2"));
    const tabs = Object.keys((await state(m)).tabs).length;
    await countTabOpens();
    for (const combo of ["Meta+t", "Meta+l", "Control+Tab", "Meta+["]) await inWindow(m, app, () => pressKeys(m, combo));
    await sleep(800);
    expect(await m.execute(`return window.webaiosTestOpened;`)).toEqual([]);
    expect(await m.execute(`return ${site}.gBrowser.tabs.length;`)).toBe(1);
    expect(await viewUrl()).toBe(url("/film/2"));
    expect(await m.execute(`return ${site}.gURLBar.focused;`)).toBe(false);
    expect(Object.keys((await state(m)).tabs).length).toBe(tabs);
    // ⌘N from the app opens a main window.
    const mains = (await state(m)).windows.length;
    await inWindow(m, app, () => pressKeys(m, "Meta+n"));
    await expect.poll(async () => (await state(m)).windows.length, { timeout: 10_000 }).toBe(mains + 1);
    await waitFor(m, `return [...Services.wm.getEnumerator("navigator:browser")].filter((x) => x.document.documentElement.hasAttribute("webaios-main")).length;`, (v) => v === 3);
    for (const h of await windowHandles(m)) if (h !== first && h !== app) await inWindow(m, h, () => m.execute(`window.close();`));
    await waitFor(m, `return [...Services.wm.getEnumerator("navigator:browser")].filter((x) => x.document.documentElement.hasAttribute("webaios-main")).length;`, (v) => v === 1);
  });

  // Last: it closes the main window.
  it("Open in a tab with no main window open: one opens, with the tab", { timeout: 60_000 }, async () => {
    const before = new Set(await windowHandles(m));
    await openAndWait();
    const app = (await windowHandles(m)).find((h) => !before.has(h))!;
    await m.execute(`window.close();`);
    await m.command("WebDriver:SwitchToWindow", { handle: app, focus: false });
    await waitFor(m, `return [...Services.wm.getEnumerator("navigator:browser")].filter((x) => x.document.documentElement.hasAttribute("webaios-main")).length;`, (v) => v === 0);
    await inSiteView(m, "vidola", "document.getElementById('pub').click(); return 1;", { gesture: true });
    await waitNotice("pub.localhost");
    await barClick("site-ouvrir-onglet");
    await waitFor(m, `return [...Services.wm.getEnumerator("navigator:browser")].filter((x) => x.document.documentElement.hasAttribute("webaios-main")).length;`, (v) => v === 1);
    await expect.poll(async () => {
      const s = await state(m);
      const f = s.windows[0];
      return s.windows.length === 1 && Object.values(s.tabs).some((o) => o.url === pub("/x") && o.windowId === f?.id);
    }, { timeout: 10_000 }).toBe(true);
    // Back on the main window for afterEach.
    const main = (await windowHandles(m)).find((h) => h !== app && !before.has(h)) ?? (await windowHandles(m)).find((h) => h !== app)!;
    await m.command("WebDriver:SwitchToWindow", { handle: main, focus: false });
  });
});
