import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testActor } from "./agent-extensions";
import { waitReady, windowHandles } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { SITE_HOME, grantSite, inSiteBar, inSiteView, resolveLocalHosts, siteWindowCount, siteWindowExpr, startSitesServer, writeSite } from "./sites";
import { missingApi } from "./ui";

// Plan 32 Task 4: the address follow.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const HOSTS = ["vidola-a.localhost", "vidola-b.localhost", "pub.localhost", "adresses.localhost", "compte.localhost", "vidola.adresses.localhost"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AVIS_CHANGE = "Vidola a changé d'adresse : vidola-b.localhost. Il faudra peut-être te reconnecter.";
const AVIS_INCHANGEE = "Vidola ne répond pas, et sa page de référence donne toujours la même adresse";
const SERIE = '<title>The Bear</title><div class="shorts" id="shorts">shorts</div><p>épisode</p>';

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let dataDir: string;
let profile: string;

const a = (p: string) => server.url("vidola-a.localhost", p);
const b = (p: string) => server.url("vidola-b.localhost", p);
const pub = (p: string) => server.url("pub.localhost", p);
const reference = (...links: string[]) => server.definir("adresses.localhost", "/", `<title>Adresses</title>${links.map((l) => `<a href="${l}">${l}</a>`).join("<br>")}`);
const referenceReads = () => server.requetes.filter((r) => r.hote === "adresses.localhost").length;
const declaration = (start = a("/serie/the-bear"), extra: object = {}) => ({
  nom: "Vidola",
  adresse: start,
  domaines: ["vidola-a.localhost"],
  connexion: ["compte.localhost"],
  suiviAdresse: { page: server.url("adresses.localhost", "/"), motif: "vidola" },
  ...extra,
});
const addressFile = (id: string) => {
  const f = path.join(dataDir, "sites", id, "adresse.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { actuel: string; anciens: string[] }) : null;
};

const inStore = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
const openSite = (id: string) => inStore(`await store.agent.request("sites.agir", { id: arguments[0], action: "ouvrir", fenetre: store.state.fenetres[0].id });`, [id]);
const viewUrl = (id: string) => m.execute<string | null>(`return ${siteWindowExpr(id)}?.gBrowser?.selectedBrowser.currentURI?.spec ?? null;`);
const viewAt = (id: string, u: string) => expect.poll(() => viewUrl(id), { timeout: 20_000 }).toBe(u);
const stable = (id: string) => expect.poll(() => inSiteView(m, id, "return document.readyState;").catch(() => null), { timeout: 15_000 }).toBe("complete");
const bar = <T = unknown>(id: string, body: string) => inSiteBar<T>(m, id, `if (!doc.querySelector('[data-testid="barre-site"]')) return null; ${body}`);
const text = (id: string, testid: string) => bar<string | null>(id, `return doc.querySelector('[data-testid="${testid}"]')?.textContent ?? null;`);
const expectText = (id: string, testid: string, expected: string) => expect.poll(() => text(id, testid), { timeout: 20_000 }).toBe(expected);
const expectNotice = (id: string, host: string) => expect.poll(() => text(id, "site-avis"), { timeout: 20_000 }).toContain(`Lien vers ${host} bloqué`);
const barClick = (id: string, testid: string) =>
  inSiteBar(
    m,
    id,
    `for (let i = 0; i < 100 && !doc.querySelector('[data-testid="' + arguments[0] + '"]'); i++) await new Promise((r) => setTimeout(r, 100));
     const r = doc.querySelector('[data-testid="' + arguments[0] + '"]').getBoundingClientRect();
     for (const type of ["mousedown", "mouseup"]) doc.defaultView.synthesizeMouseEvent(type, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1 });
     return true;`,
    [testid],
  );
/** A real WebDriver click on `selector` in the home's frame of app `id` (sites-home.e2e.ts realClick). */
async function realClickInHome(id: string, selector: string): Promise<void> {
  const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  try {
    let found = false;
    for (const h of await windowHandles(m)) {
      await m.command("WebDriver:SwitchToWindow", { handle: h, focus: false });
      if ((found = (await m.execute<string | null>(`return document.documentElement.getAttribute("webaios-site");`)) === id)) break;
    }
    if (!found) throw new Error(`no window for ${id}`);
    const [x, y] = await m.execute<[number, number]>(
      `const bar = document.getElementById("webaios-site-bar");
       const home = bar.contentDocument.querySelector('[data-testid="site-cadre-accueil"]');
       const b = bar.getBoundingClientRect(), h = home.getBoundingClientRect(), e = home.contentDocument.querySelector(arguments[0]).getBoundingClientRect();
       return [Math.round(b.left + h.left + e.left + e.width / 2), Math.round(b.top + h.top + e.top + e.height / 2)];`,
      [selector],
    );
    await m.command("WebDriver:PerformActions", {
      actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x, y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
    });
    await m.command("WebDriver:ReleaseActions");
  } finally {
    await m.command("WebDriver:SwitchToWindow", { handle: main, focus: false });
  }
}
const homeFrame = <T>(id: string, body: string) =>
  inSiteBar<T>(m, id, `const home = doc.querySelector('[data-testid="site-cadre-accueil"]'); if (!home?.contentDocument?.getElementById("domaine")) return null; ${body}`);

/** Writes (and grants) app `id`, opens it. `open: false` leaves it closed. */
async function setup(id: string, decl: object, files: Record<string, string> = {}, o: { grant?: boolean } = {}): Promise<void> {
  writeSite(dataDir, id, { declaration: decl, fichiers: files });
  if (o.grant) await grantSite(dataDir, id, decl);
}
/** Opens `id` and waits for its page (`path` on vidola-a) to be loaded. */
async function openAndWait(id: string, p = "/"): Promise<void> {
  await openSite(id);
  await viewAt(id, a(p));
  await stable(id);
}

beforeAll(async () => {
  server = await startSitesServer();
  const d = (p: string, body: Parameters<typeof server.definir>[2]) => server.definir("vidola-a.localhost", p, body);
  d("/serie/the-bear", SERIE);
  server.definir("vidola-b.localhost", "/serie/the-bear", SERIE);
  d("/parque", (_req, res) => res.writeHead(302, { Location: pub("/arrivee") }).end());
  d("/", `<title>Vidola A</title><a id="pub" href="${pub("/x")}">pub</a><a id="aller-pub" href="/aller-pub">aller</a>`);
  d("/aller-pub", (_req, res) => res.writeHead(302, { Location: pub("/arrivee") }).end());
  d("/film/2", "<title>Film 2</title>");
  server.definir("vidola-b.localhost", "/film/2", "<title>Film 2 B</title>");
  server.definir("pub.localhost", "/x", "<title>Pub</title>");
  server.definir("pub.localhost", "/arrivee", "<title>Arrivée pub</title>");
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  const actor = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1", ...actor.env }, prefs: actor.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, HOSTS);
}, 90_000);
afterAll(async () => {
  await w?.close();
  await server?.fermer();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (profile) await rm(profile, { recursive: true, force: true });
});
beforeEach(() => {
  server.requetes.splice(0);
  server.couper("vidola-a.localhost", false);
  reference(b("/"));
});
afterEach(async () => {
  server.couper("vidola-a.localhost", false);
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await inStore(`for (const id of store.sites.openIds()) await store.sites.close(id);`).catch(() => {});
  }
});

describe("site app address follow", () => {
  it("vidola-a stopped, adresses.localhost lists vidola-b: the window goes to vidola-b and says so; reopened: vidola-b directly, no reading (sites.spec.ts:1357)", async () => {
    await setup("t58", declaration());
    server.couper("vidola-a.localhost");
    await openSite("t58");
    await viewAt("t58", b("/serie/the-bear"));
    await expectText("t58", "site-avis", AVIS_CHANGE);
    await expectText("t58", "site-domaine", "vidola-b.localhost");
    expect(addressFile("t58")).toMatchObject({ actuel: "vidola-b.localhost", anciens: ["vidola-a.localhost"] });
    expect(referenceReads()).toBe(1);
    await inStore(`await store.sites.close("t58");`);
    await expect.poll(() => siteWindowCount(m, "t58")).toBe(0);
    server.requetes.splice(0);
    await openSite("t58");
    await viewAt("t58", b("/serie/the-bear"));
    await expectText("t58", "site-domaine", "vidola-b.localhost");
    expect(referenceReads()).toBe(0);
    expect(server.requetes.some((r) => r.hote === "vidola-a.localhost")).toBe(false);
  });

  it("a /serie/* retouche applies on vidola-b; the memory kept on vidola-a reopens from the home on vidola-b (sites.spec.ts:1384)", async () => {
    const decl = declaration(a("/serie/the-bear"), { retouches: [{ correspond: ["/serie/*"], css: ["cacher.css"] }] });
    await setup("t59", decl, { "accueil/index.html": SITE_HOME, "retouches/cacher.css": ".shorts { display: none; }" }, { grant: true });
    mkdirSync(path.join(dataDir, "sites", "t59"), { recursive: true });
    writeFileSync(
      path.join(dataDir, "sites", "t59", "memoire.json"),
      JSON.stringify({ version: 1, valeurs: { "encours.the-bear": { valeur: { titre: "The Bear" }, adresse: "/serie/the-bear?e=4", quand: new Date().toISOString() } }, positions: {} }),
    );
    server.couper("vidola-a.localhost");
    await openSite("t59");
    await expect.poll(() => homeFrame("t59", `return home.contentDocument.getElementById("series").textContent;`), { timeout: 15_000 }).toContain("The Bear");
    await barClick("t59", "site-entrer");
    await viewAt("t59", b("/serie/the-bear"));
    await expectText("t59", "site-avis", AVIS_CHANGE);
    await expect.poll(() => inSiteView(m, "t59", 'return getComputedStyle(document.getElementById("shorts")).display;').catch(() => null), { timeout: 15_000 }).toBe("none");
    await barClick("t59", "site-accueil");
    await expect.poll(() => homeFrame("t59", `return home.contentDocument.getElementById("domaine").textContent;`), { timeout: 15_000 }).toBe("vidola-b.localhost");
    await homeFrame("t59", `home.contentWindow.wrappedJSObject.adresse = "/serie/the-bear?e=4"; return true;`);
    await realClickInHome("t59", "#ouvrir");
    await viewAt("t59", b("/serie/the-bear?e=4"));
  });

  it("vidola-a redirects to pub.localhost (a parked domain) on opening: the follow starts (sites.spec.ts:1420)", async () => {
    await setup("t60", declaration(a("/parque")));
    await openSite("t60");
    await expectText("t60", "site-avis", AVIS_CHANGE);
    // The aimed path does not exist at vidola-b: it goes there anyway (the site answers there).
    await viewAt("t60", b("/parque"));
    expect(addressFile("t60")?.actuel).toBe("vidola-b.localhost");
    expect(server.requetes.some((r) => r.hote === "pub.localhost")).toBe(false);
  });

  it("a redirect off the site after a click in the page does not start the follow (sites.spec.ts:1432)", async () => {
    await setup("t61", declaration(a("/")));
    await openAndWait("t61");
    await inSiteView(m, "t61", "document.getElementById('aller-pub').click(); return 1;", { gesture: true });
    await expectNotice("t61", "pub.localhost");
    await sleep(800);
    expect(referenceReads()).toBe(0);
    expect(addressFile("t61")).toBeNull();
  });

  it("a trapped reference page: « Adresse introuvable sur adresses.localhost », the app stays on vidola-a (sites.spec.ts:1444)", async () => {
    reference(server.url("vidola.adresses.localhost", "/"), server.url("adresses.localhost", "/vidola-b"), pub("/vidola"), "http://vidola-b.example/", "javascript:alert(1)");
    await setup("t62", declaration());
    server.couper("vidola-a.localhost");
    await openSite("t62");
    await expectText("t62", "site-avis", "Adresse introuvable sur adresses.localhost");
    await expectText("t62", "site-domaine", "vidola-a.localhost");
    expect(addressFile("t62")).toBeNull();
    expect(server.requetes.some((r) => r.hote === "vidola-b.localhost" || r.hote === "pub.localhost")).toBe(false);
  });

  it("the reference read sends no cookie, even if the app's container and the default one hold one for adresses.localhost (sites.spec.ts:1457)", async () => {
    await setup("t63", declaration(a("/")));
    await openAndWait("t63");
    // The cookie is set the way a site sets it (the test server's /cookie), in the default container and in container 1,
    // by tabs of the main window. (The app's own container cannot be written from outside its view: the request guard
    // refuses any other browser, and Services.cookies.add stores nothing in this profile.)
    const seen = await m.execute<number>(
      `return (async (url) => { const win = [...Services.wm.getEnumerator("navigator:browser")].find((x) => !x.document.documentElement.hasAttribute("webaios-site"));
       const system = Services.scriptSecurityManager.getSystemPrincipal();
       for (const userContextId of [0, 1]) {
         const tab = win.gBrowser.addTab(url, { userContextId, triggeringPrincipal: system });
         for (let i = 0; i < 100 && (tab.linkedBrowser.currentURI.spec !== url || tab.linkedBrowser.webProgress.isLoadingDocument); i++) await new Promise((r) => setTimeout(r, 100));
         win.gBrowser.removeTab(tab);
       }
       return [0, 1].filter((userContextId) => Services.cookies.getCookiesFromHost("adresses.localhost", { userContextId }).some((c) => c.name === "essai")).length; })(arguments[0]);`,
      [server.url("adresses.localhost", "/cookie")],
    );
    expect(seen).toBe(2);
    server.requetes.splice(0);
    await barClick("t63", "site-chercher-adresse");
    await expect.poll(referenceReads, { timeout: 20_000 }).toBeGreaterThan(0);
    const reads = server.requetes.filter((r) => r.hote === "adresses.localhost");
    expect(reads.every((r) => r.cookie === undefined)).toBe(true);
  });

  it("« Chercher la nouvelle adresse » twice in 10 s: one reading (sites.spec.ts:1470)", async () => {
    reference(a("/"));
    await setup("t64", declaration(a("/")));
    await openAndWait("t64");
    await expectText("t64", "site-chercher-adresse", "Chercher la nouvelle adresse");
    await barClick("t64", "site-chercher-adresse");
    await expectText("t64", "site-avis", AVIS_INCHANGEE);
    await barClick("t64", "site-chercher-adresse");
    await sleep(800);
    expect(referenceReads()).toBe(1);
  });

  it("while reading the button is disabled and busy; a click too early gives the last result again after a blocked link (sites.spec.ts:1485)", async () => {
    server.definir("adresses.localhost", "/", (_req, res) => {
      setTimeout(() => res.writeHead(200, { "Content-Type": "text/html" }).end(`<title>Adresses</title><a href="${a("/")}">a</a>`), 1200);
    });
    await setup("t65", declaration(a("/")));
    await openAndWait("t65");
    const state = () => bar<{ disabled: boolean; busy: string | null }>("t65", `const e = doc.querySelector('[data-testid="site-chercher-adresse"]'); return e && { disabled: e.disabled, busy: e.getAttribute("aria-busy") };`);
    await barClick("t65", "site-chercher-adresse");
    await expect.poll(state, { timeout: 10_000 }).toEqual({ disabled: true, busy: "true" });
    await expectText("t65", "site-avis", AVIS_INCHANGEE);
    await expect.poll(state, { timeout: 10_000 }).toEqual({ disabled: false, busy: "false" });
    // A blocked link replaces the notice; a click too early (no reading) gives the last result again.
    await inSiteView(m, "t65", "document.getElementById('pub').click(); return 1;", { gesture: true });
    await expectNotice("t65", "pub.localhost");
    server.requetes.splice(0);
    await barClick("t65", "site-chercher-adresse");
    await expectText("t65", "site-avis", AVIS_INCHANGEE);
    expect(referenceReads()).toBe(0);
  });

  it("the button aims at the page shown on the site, not at the target of a blocked link (sites.spec.ts:1509)", async () => {
    await setup("t66", declaration(a("/film/2")));
    await openAndWait("t66", "/film/2");
    await inSiteView(m, "t66", `location.href = ${JSON.stringify(pub("/x"))}; return 1;`, { gesture: true });
    await expectNotice("t66", "pub.localhost");
    await barClick("t66", "site-chercher-adresse");
    await viewAt("t66", b("/film/2"));
  });

  it("↻ in the bar while vidola-a now redirects to pub.localhost: the follow starts (reload is a load WebAiOs started)", async () => {
    let parked = false;
    server.definir("vidola-a.localhost", "/recharge", (_req, res) => (parked ? res.writeHead(302, { Location: pub("/arrivee") }).end() : res.writeHead(200, { "Content-Type": "text/html" }).end("<title>R</title>ok")));
    await setup("t68", declaration(a("/recharge")));
    await openAndWait("t68", "/recharge");
    expect(referenceReads()).toBe(0);
    parked = true;
    await barClick("t68", "site-recharger");
    await expectText("t68", "site-avis", AVIS_CHANGE);
    expect(referenceReads()).toBe(1);
    expect(server.requetes.some((r) => r.hote === "pub.localhost")).toBe(false);
  });

  it("an app without suiviAdresse has no button (sites.spec.ts:1521)", async () => {
    await setup("t67", declaration(a("/"), { suiviAdresse: undefined }));
    await openAndWait("t67");
    expect(await bar<number>("t67", `return doc.querySelectorAll('[data-testid="site-chercher-adresse"]').length + 1;`)).toBe(1);
  });
});
