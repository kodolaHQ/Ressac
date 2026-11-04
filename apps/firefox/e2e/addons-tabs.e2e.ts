import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EtatNavigateur, Onglet } from "../../navigateur/src/commun/modele";
import { button, cleanupXpis, installAddon, options, probe, uninstallAddon } from "./addons";
import { dispatch, inWindow, newWindow, state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
// Tabs opened by add-ons, and about:addons, as WebAiOs tabs (Electron's extensions.spec.ts and extensions-interface.spec.ts).

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(async () => {
  await server?.close();
  await cleanupXpis();
});
beforeEach(async () => {
  w = await launchWebAiOs();
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
});
afterEach(() => w?.close());

const win = async () => (await state(m)).fenetres[0]!;

async function waitState<T>(read: (s: EtatNavigateur) => T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read(await state(m));
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const tabWith = (part: string) => waitState((s) => Object.values(s.onglets).find((o) => o.url.includes(part)), (o) => !!o) as Promise<Onglet>;
const selectedId = () => m.execute<string | null>("return gBrowser.selectedTab.getAttribute('webaios-tab-id')");
/** A chrome script returning `expr` about the about:addons page `win` of WebAiOs tab `id` (it lives in the parent process). */
const onPage = (id: string, expr: string) =>
  `const win = gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === ${JSON.stringify(id)})?.linkedBrowser.contentWindow; return ${expr};`;
const VIEW = "win?.gViewController?.currentViewId ?? null";

/** Electron's three actions: the trigger page opens in space A, then the window goes to space B at once. */
async function triggerFromA(query: string, profil: string): Promise<{ a: string; b: string }> {
  const fenetreId = (await win()).id;
  const a = (await win()).espaceActif;
  await dispatch(m, { type: "creerEspace", nom: "B", icone: "🅱", prive: false, profil, fenetreId });
  const b = (await win()).espaceActif;
  await dispatch(m, { type: "activerEspace", fenetreId, id: a });
  await dispatch(m, { type: "ouvrirOnglet", fenetreId, url: `${server.url}/a.html?${query}` });
  await dispatch(m, { type: "activerEspace", fenetreId, id: b });
  return { a, b };
}

describe("tabs opened by add-ons", () => {
  it("tabs.create from an add-on opens a tab in the window's active space", async () => {
    await installAddon(m, probe());
    const { b } = await triggerFromA("ouvrir-onglet", "defaut");
    const opened = await tabWith("ouverte-par-sonde");
    expect(opened.espaceId).toBe(b);
    expect((await win()).espaceActif).toBe(b);
  });

  it("tabs.create({ active: true }) never changes the window's space", async () => {
    await installAddon(m, probe());
    const { b } = await triggerFromA("ouvrir-actif", "defaut");
    const opened = await tabWith("ouverte-active");
    expect(opened.espaceId).toBe(b);
    await waitState((s) => s.fenetres[0]!.actif[b], (id) => id === opened.id);
    expect((await win()).espaceActif).toBe(b);
    expect(await selectedId()).toBe(opened.id);
  });

  it("an add-on tab in a space of another profile loads in that space's container", async () => {
    await installAddon(m, probe());
    // Recreated in the right container, its first request would have gone out with the default profile's cookies.
    await m.execute("window.closedTabs = 0; gBrowser.tabContainer.addEventListener('TabClose', () => window.closedTabs++)");
    const { b } = await triggerFromA("ouvrir-onglet", "nouveau");
    const opened = await tabWith("ouverte-par-sonde");
    expect(opened.espaceId).toBe(b);
    const profileB = (await state(m)).espaces.find((e) => e.id === b)!.profil;
    const container = await m.execute<number>(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).containerFor(arguments[0]))();`, [profileB]);
    const xul = await waitFor(
      m,
      `const t = gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === "${opened.id}");
       return t && { userContextId: t.userContextId, url: t.linkedBrowser.currentURI.spec };`,
      (v: { userContextId: number; url: string } | undefined) => !!v?.url.includes("ouverte-par-sonde"),
    );
    expect(xul!.userContextId).toBe(container);
    expect(await m.execute("return window.closedTabs")).toBe(0);
  });

  it("tabs.create with a URL relative to the add-on is adopted", async () => {
    await installAddon(m, probe());
    await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await win()).id, url: `${server.url}/a.html?ouvrir-page` });
    const page = await tabWith("/page.html");
    expect(page.url).toMatch(/^moz-extension:\/\/.+\/page\.html$/);
    await waitState((s) => s.onglets[page.id]?.titre, (t) => t === "Page de la sonde");
  });
});

/** The add-on's runtime.openOptionsPage(), called from the parent process as the API does. */
const openOptionsPage = (id: string) =>
  m.execute(
    `const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
     return ExtensionParent.apiManager.global.openOptionsPage(ExtensionParent.GlobalManager.getExtension(arguments[0])).then(() => 0);`,
    [id],
  );

describe("options pages in a tab", () => {
  it("open as a visible WebAiOs tab when no page is displayed, every time", async () => {
    const id = await installAddon(m, options({ inTab: true }));
    for (let i = 0; i < 2; i++) {
      await openOptionsPage(id);
      const page = await tabWith("/options.html");
      await waitFor(m, "return gBrowser.selectedTab.getAttribute('webaios-tab-id')", (v) => v === page.id);
      expect(await m.execute("return gBrowser.tabs.filter((t) => t.hasAttribute('webaios-parking')).map((t) => t.linkedBrowser.currentURI.spec)")).toEqual(["about:blank"]);
      await dispatch(m, { type: "fermerOnglet", id: page.id });
    }
  });

  it("an options page already open comes back in the state, in its own space", async () => {
    const id = await installAddon(m, options({ inTab: true }));
    await openOptionsPage(id);
    const page = await tabWith("/options.html");
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('webaios-tab-id')", (v) => v === page.id);
    const fenetreId = (await win()).id;
    await dispatch(m, { type: "ouvrirOnglet", fenetreId, url: `${server.url}/a.html` });
    await dispatch(m, { type: "creerEspace", nom: "B", icone: "🅱", prive: false, profil: "defaut", fenetreId });
    await dispatch(m, { type: "ouvrirOnglet", fenetreId, url: `${server.url}/b.html` });
    await openOptionsPage(id);
    const f = await waitState((s) => s.fenetres[0]!, (x) => x.espaceActif === page.espaceId && x.actif[page.espaceId] === page.id);
    expect(f.actif[f.espaceActif]).toBe(page.id);
    expect(await selectedId()).toBe(page.id);
    expect(Object.values((await state(m)).onglets).filter((o) => o.url.includes("/options.html"))).toHaveLength(1);
  });
});

describe("about:addons", () => {
  it("Tools › Add-ons opens about:addons once, as a WebAiOs tab", async () => {
    await installAddon(m, button());
    await m.execute('document.getElementById("menu_openAddons").doCommand(); document.getElementById("menu_openAddons").doCommand();');
    const tab = await tabWith("about:addons");
    await waitFor(m, onPage(tab.id, VIEW), (v) => v === "addons://list/extension");
    const s = await state(m);
    expect(Object.values(s.onglets).filter((o) => o.url.startsWith("about:addons"))).toHaveLength(1);
    expect(s.fenetres[0]!.actif[s.fenetres[0]!.espaceActif]).toBe(tab.id);
    await waitFor(m, onPage(tab.id, `win.document.querySelector('addon-card[addon-id="button@webaios.test"]')?.textContent ?? ""`), (t: string) => t.includes("Bouton de test"));
  });

  it("an add-on's options open as WebAiOs tabs", async () => {
    const fenetreId = (await win()).id;
    const inTab = await installAddon(m, options({ inTab: true }));
    await dispatch(m, { type: "ouvrirOnglet", fenetreId, url: `${server.url}/a.html?options` });
    const page = await tabWith("/options.html");
    expect(page.url).toMatch(/^moz-extension:\/\/.+\/options\.html$/);
    expect(page.espaceId).toBe((await win()).espaceActif);
    await uninstallAddon(m, inTab);

    const embedded = await installAddon(m, options({ inTab: false }));
    await dispatch(m, { type: "ouvrirOnglet", fenetreId, url: `${server.url}/a.html?options` });
    const addons = await tabWith("about:addons");
    await waitFor(m, onPage(addons.id, VIEW), (v) => v === `addons://detail/${encodeURIComponent(embedded)}/preferences`);
  });

  it("about:addons opened from a second window stays in that window", async () => {
    const first = await win();
    const second = await newWindow(m);
    const id2 = await inWindow(m, second, async () => {
      await m.execute("return BrowserAddonUI.openAddonsMgr().then(() => 0)");
      return m.execute<string>("return window.webaiosWindow.fenetreId");
    });
    const tab = await tabWith("about:addons");
    expect(tab.fenetreId).toBe(id2);
    const after = (await state(m)).fenetres.find((f) => f.id === first.id)!;
    expect(after.actif).toEqual(first.actif);
    expect(after.ordre).toEqual(first.ordre);
    expect(after.espaceActif).toBe(first.espaceActif);
  });
});
