import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { testActor } from "./agent-extensions";
import { dispatch, state, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { SITE_HOME, grantSite, inBrowser, resolveLocalHosts, siteWindowCount, startSitesServer, writeSite } from "./sites";
import { click, missingApi, waitUi } from "./ui";

// Plan 76 Task 3: where a site app lives — an essential (its own container), the sidebar bar, or nowhere.

const HOSTS = ["vidola-a.localhost", "autre-a.localhost", "maison-a.localhost"];

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedRessac;
let m: Marionette;
let dataDir: string;
let profile: string;

const url = (p: string, host = "vidola-a.localhost") => server.url(host, p);
const vidola = () => ({ name: "Vidola", url: url("/"), domains: ["vidola-a.localhost"], login: [], tweaks: [{ matches: ["/*"], js: ["marque.js"] }] });
const maison = () => ({ name: "Maison", url: url("/", "maison-a.localhost"), domains: ["maison-a.localhost"], login: [] });
const autre = () => ({ name: "Autre", url: url("/", "autre-a.localhost"), domains: ["autre-a.localhost"], login: [] });

async function openPage(): Promise<void> {
  await dispatch(m, { type: "openApps", windowId: (await state(m)).windows[0]!.id });
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"page-applications\"]')");
}
/** A placement chosen in the row's « … » menu. */
async function place(id: string, label: string): Promise<void> {
  await click(m, `[data-testid="site-${id}-more"]`);
  await click(m, '[role="menuitemradio"]', { text: label });
}
const shown = (testid: string, yes = true) => waitUi(m, `return !!doc.querySelector('[data-testid="' + arguments[0] + '"]') === arguments[1];`, [testid, yes]);
/** The app's essential in the state, once it is there. */
const essential = async (id: string) => (await state(m)).essentials.find((x) => x.site === id);
/** The Ressac tab of essential `favoriteId` in the first window, once it is made. */
async function essentialTab(favoriteId: string): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(async () => {
      const s = await state(m);
      id = Object.values(s.tabs).find((o) => o.link?.id === favoriteId && o.windowId === s.windows[0]!.id)?.id;
      return !!id;
    }, { timeout: 10_000 })
    .toBe(true);
  return id!;
}
/** The link of the first window's shown tab. */
const shownLink = async () => {
  const s = await state(m);
  const f = s.windows[0]!;
  return s.tabs[f.active[f.activeSpace] ?? ""]?.link?.id ?? null;
};
const xulTab = (tabId: string) => `gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === ${JSON.stringify(tabId)})`;
const windows = (id: string) => siteWindowCount(m, id);

beforeAll(async () => {
  server = await startSitesServer();
  server.define("vidola-a.localhost", "/", "<title>Vidola</title><p>vidola</p>");
  server.define("autre-a.localhost", "/", "<title>Autre</title><p>autre</p>");
  server.define("maison-a.localhost", "/", "<title>Maison</title><p>maison</p>");
  server.define("maison-a.localhost", "/serie", "<title>Série</title><p>serie</p>");
  dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  writeSite(dataDir, "vidola", { declaration: vidola(), files: { "tweaks/marque.js": 'document.documentElement.dataset.retouche = "oui";' } });
  writeSite(dataDir, "autre", { declaration: autre() });
  writeSite(dataDir, "maison", { declaration: maison(), files: { "home/index.html": SITE_HOME } });
  await grantSite(dataDir, "vidola", vidola());
  const actor = testActor(profile);
  w = await launchRessac({ dataDir, profile, env: { RESSAC_TEST_LOCAL_ADDRESSES: "1", ...actor.env }, prefs: actor.prefs });
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
afterEach(async () => expect(await missingApi(m)).toEqual([]));

// One app taken through every placement, in order: each step starts where the last one left it.
describe("site app placement", () => {

  it("« Dans les essentiels »: an essential in the app's container, its window closed, its tweaks applied in the tab", async () => {
    await openPage();
    await click(m, '[data-testid="site-vidola-open"]');
    await expect.poll(() => windows("vidola"), { timeout: 15_000 }).toBe(1);
    await place("vidola", "Dans les essentiels");
    await shown("essential-site-vidola");
    await expect.poll(() => windows("vidola"), { timeout: 10_000 }).toBe(0);
    const favorite = (await essential("vidola"))!;
    expect(favorite.url).toBe(url("/"));
    const tab = await essentialTab(favorite.id);
    const container = await m.execute<number>(
      `const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
       return ContextualIdentityService.getPrivateIdentity("userContextIdInternal.webaios-site-vidola")?.userContextId ?? -1;`,
    );
    expect(container).toBeGreaterThan(0);
    await expect.poll(() => m.execute<number | null>(`return ${xulTab(tab)}?.userContextId ?? null;`), { timeout: 10_000 }).toBe(container);
    // Shown, the tab loads the app with its tweak.
    await click(m, '[data-testid="essential-site-vidola"]');
    await expect
      .poll(() => inBrowser<string | null>(m, `${xulTab(tab)}.linkedBrowser`, "return document.documentElement?.dataset.retouche ?? null;").catch(() => null), { timeout: 15_000 })
      .toBe("oui");
  });

  it("« Dans la barre »: the essential goes, an icon in the bar opens the app's window and shows it open", async () => {
    await openPage();
    await place("vidola", "Dans la barre");
    await shown("essential-site-vidola", false);
    expect(await essential("vidola")).toBeUndefined();
    await shown("site-bar-vidola");
    await click(m, '[data-testid="site-bar-vidola"]');
    await expect.poll(() => windows("vidola"), { timeout: 15_000 }).toBe(1);
    await waitUi(m, "return doc.querySelector('[data-testid=\"site-bar-vidola\"]')?.hasAttribute('data-open')");
  });

  it("right click on the bar icon › « Mettre dans les essentiels »: back in the essentials, out of the bar", async () => {
    await click(m, '[data-testid="site-bar-vidola"]', { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Mettre dans les essentiels" });
    await shown("essential-site-vidola");
    await shown("site-bar-vidola", false);
    expect((await state(m)).siteBar).not.toContain("vidola");
    await expect.poll(() => windows("vidola"), { timeout: 10_000 }).toBe(0);
  });

  it("« Ouvrir » on an app in the essentials shows its tab, no window", async () => {
    await openPage();
    await click(m, '[data-testid="site-vidola-open"]');
    const favorite = (await essential("vidola"))!;
    await expect.poll(shownLink, { timeout: 10_000 }).toBe(favorite.id);
    expect(await windows("vidola")).toBe(0);
  });

  it("deleting the app takes it out of the essentials and the bar", async () => {
    await dispatch(m, { type: "placeSite", id: "autre", placement: "bar" });
    await shown("site-bar-autre");
    await openPage();
    for (const id of ["vidola", "autre"]) {
      await click(m, `[data-testid="site-${id}-more"]`);
      await click(m, '[role="menuitem"]', { text: "Supprimer" });
      await click(m, '[data-testid="confirm-site-delete"]');
      await waitUi(m, "return !doc.querySelector(arguments[0])", [`[data-testid="site-${id}"]`]);
    }
    await shown("essential-site-vidola", false);
    await shown("site-bar-autre", false);
    const s = await state(m);
    expect(s.essentials.some((x) => x.site)).toBe(false);
    expect(s.siteBar).toEqual([]);
  });
});

// An app with a home, in the essentials: the home over its tab, as its window opens on it.
describe("an app essential's home", () => {
  /** Chrome expression: the home's frame over the tab's page (store/sites.ts renderTab), if shown and not leaving. */
  const homeOver = (tab: string) => `${xulTab(tab)}?.linkedBrowser.parentNode.querySelector(".ressac-tab-home:not([leaving])")`;
  /** The home page's window (Xrays waived) once it shows the app's served copy, else null. */
  const homePage = (tab: string, body: string, args: unknown[] = []) =>
    m.execute(
      `const f = ${homeOver(tab)}?.contentDocument?.querySelector('[data-testid="site-home-frame"]');
       const fw = f?.contentDocument?.defaultView?.wrappedJSObject;
       if (!fw || !String(f.contentDocument.documentURI).startsWith("resource://ressac-site-")) return null;
       ${body}`,
      args,
    );
  const homeShown = (tab: string) => homePage(tab, "return (fw.recus ?? []).length > 0;").then((x) => x === true, () => false);
  const tabUrl = (tab: string) => m.execute<string>(`return ${xulTab(tab)}?.linkedBrowser.currentURI?.spec ?? "";`);

  /** A real click on `selector` in the tab's home (WebDriver actions in the main window, through both frames). */
  async function realClick(tab: string, selector: string): Promise<void> {
    const [x, y] = await m.execute<[number, number]>(
      `const o = ${homeOver(tab)}, f = o.contentDocument.querySelector('[data-testid="site-home-frame"]');
       const a = o.getBoundingClientRect(), b = f.getBoundingClientRect(), e = f.contentDocument.querySelector(arguments[0]).getBoundingClientRect();
       return [Math.round(a.left + b.left + e.left + e.width / 2), Math.round(a.top + b.top + e.top + e.height / 2)];`,
      [selector],
    );
    await m.command("WebDriver:PerformActions", {
      actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x, y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
    });
    await m.command("WebDriver:ReleaseActions");
  }

  it("a click on the essential shows the home over the loaded site; an open from the home goes there; the essential and « Accueil de l'appli » bring it back", async () => {
    await dispatch(m, { type: "placeSite", id: "maison", placement: "essentials", url: url("/", "maison-a.localhost"), title: "Maison", favicon: null });
    await shown("essential-site-maison");
    const tab = await essentialTab((await essential("maison"))!.id);
    await click(m, '[data-testid="essential-site-maison"]');
    await expect.poll(() => homeShown(tab), { timeout: 15_000 }).toBe(true);
    // The site is loaded under the home.
    await expect.poll(() => tabUrl(tab), { timeout: 15_000 }).toBe(url("/", "maison-a.localhost"));

    // An open the home posts without a real press (a scripted click) is refused: the tab stays where it is.
    await homePage(tab, 'fw.adresse = "/serie"; fw.document.getElementById("ouvrir").click(); return true;');
    await new Promise((r) => setTimeout(r, 1500));
    expect(await tabUrl(tab)).toBe(url("/", "maison-a.localhost"));
    expect(await homeShown(tab)).toBe(true);
    await realClick(tab, "#ouvrir");
    // Not the start address: the « Ouvrir l'appli ? » card over the tab's home shows it whole; nothing loads before « Ouvrir ».
    const card = `${homeOver(tab)}?.contentDocument.querySelector('[data-testid="site-start-card"][data-armed]')`;
    await expect.poll(() => m.execute<string | null>(`return ${card}?.querySelector('[data-testid="site-start-url"]').textContent ?? null;`), { timeout: 10_000 }).toBe(url("/serie", "maison-a.localhost"));
    expect(await tabUrl(tab)).toBe(url("/", "maison-a.localhost"));
    await m.execute(`${card}.querySelector('[data-testid="accept-start"]').click(); return true;`);
    await expect.poll(() => tabUrl(tab), { timeout: 15_000 }).toBe(url("/serie", "maison-a.localhost"));
    await expect.poll(() => m.execute<boolean>(`return !${homeOver(tab)};`), { timeout: 5_000 }).toBe(true);

    // A click on the selected essential: the home again, the page under it unchanged.
    await click(m, '[data-testid="essential-site-maison"]');
    await expect.poll(() => homeShown(tab), { timeout: 15_000 }).toBe(true);
    expect(await tabUrl(tab)).toBe(url("/serie", "maison-a.localhost"));

    // « Entrer dans le site » hides it; right click › « Accueil de l'appli » shows it.
    await m.execute(`${homeOver(tab)}.contentDocument.querySelector('[data-testid="site-enter"]').click(); return true;`);
    await expect.poll(() => m.execute<boolean>(`return !${homeOver(tab)};`), { timeout: 5_000 }).toBe(true);
    await click(m, '[data-testid="essential-site-maison"]', { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Accueil de l'appli" });
    await expect.poll(() => homeShown(tab), { timeout: 15_000 }).toBe(true);
  });
});
