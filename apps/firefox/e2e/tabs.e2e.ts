import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import type { EtatNavigateur } from "../../navigateur/src/commun/modele";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";

const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
// Each test launches its own WebAiOs.
beforeEach(async () => {
  w = await launchWebAiOs();
  m = w.marionette;
  await m.setContext("chrome");
  // The window controller is up once it has marked the parking tab.
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
});
afterEach(() => w?.close());

/** Dispatches `action` and returns the id of the tab it created. */
async function opened(action: Action): Promise<string> {
  const before = new Set(Object.keys((await state(m)).onglets));
  const after = await dispatch(m, action);
  return Object.keys(after.onglets).find((id) => !before.has(id))!;
}

const win = async () => (await state(m)).fenetres[0]!;
const open = async (path: string, extra: Partial<Extract<Action, { type: "ouvrirOnglet" }>> = {}) =>
  opened({ type: "ouvrirOnglet", fenetreId: (await win()).id, url: server.url + path, ...extra });

function waitState<T>(read: (s: EtatNavigateur) => T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  return (async () => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = read(await state(m));
      if (ok(v)) return v;
      if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
}
const waitTitle = (id: string, title: string) => waitState((s) => s.onglets[id]?.titre, (t) => t === title);

const markedTabs = () => m.execute<number>("return gBrowser.tabs.filter((t) => t.hasAttribute('webaios-tab-id')).length");
const selected = () =>
  m.execute<{ id: string | null; parking: boolean }>(
    "return { id: gBrowser.selectedTab.getAttribute('webaios-tab-id'), parking: gBrowser.selectedTab.hasAttribute('webaios-parking') }",
  );

/** Runs `script` in the page of WebAiOs tab `id` (content context), then comes back to the chrome context. */
async function inPage<T>(id: string, script: string): Promise<T> {
  const handle = await m.execute<string>(
    `const t = gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === arguments[0]);
     return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(t.linkedBrowser);`,
    [id],
  );
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  try {
    return await m.execute<T>(script);
  } finally {
    await m.setContext("chrome");
  }
}

/** Clicks `selector` in the page of tab `id`, as a user would (Marionette's element click). */
async function click(id: string, selector: string): Promise<void> {
  await inPage(id, "return 0");
  await m.setContext("content");
  try {
    const found = await m.command<{ value: Record<string, string> }>("WebDriver:FindElement", { using: "css selector", value: selector });
    await m.command("WebDriver:ElementClick", { id: Object.values(found.value)[0] });
  } finally {
    await m.setContext("chrome");
  }
}

describe("window controller", () => {
  it("loads a tab opened by dispatch and reports its title", async () => {
    // Records every URL the state gives the tab: the XUL tab's initial about:blank must not leak into it.
    await m.execute(`window.urls = new Set(); window.webaiosWindow.store.subscribe((s) => { for (const o of Object.values(s.onglets)) urls.add(o.url); });`);
    const id = await open("/a.html");
    await waitTitle(id, "Page A");
    await waitState((s) => s.onglets[id]!.chargement, (c) => c === false);
    expect((await state(m)).onglets[id]!.url).toBe(server.url + "/a.html");
    expect(await m.execute("return [...window.urls]")).toEqual([server.url + "/a.html"]);
  });

  it("navigates like the address bar, and goes back", async () => {
    await m.execute("webaiosWindow.navigate(null, arguments[0])", [server.url + "/a.html"]);
    const id = Object.keys((await state(m)).onglets)[0]!;
    await waitTitle(id, "Page A");
    await m.execute("webaiosWindow.navigate(arguments[0], arguments[1])", [id, server.url + "/b.html"]);
    await waitTitle(id, "Page B");
    expect((await state(m)).onglets[id]!.peutReculer).toBe(true);
    await m.execute("webaiosWindow.command(arguments[0], 'reculer')", [id]);
    await waitTitle(id, "Page A");
  });

  it("only gives the active tab a XUL tab", async () => {
    const a = await open("/a.html");
    await open("/b.html", { activer: false });
    expect(await markedTabs()).toBe(1);
    expect((await selected()).id).toBe(a);
    const b = (await win()).ordre[(await win()).espaceActif]![1]!;
    await dispatch(m, { type: "activerOnglet", id: b });
    await waitTitle(b, "Page B");
    expect(await markedTabs()).toBe(2);
    expect((await selected()).id).toBe(b);
  });

  it("opens a target=_blank link right after its source", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(a, "#lien");
    const f = await waitState((s) => s.fenetres[0]!, (f) => f.ordre[f.espaceActif]!.length === 2);
    const b = f.ordre[f.espaceActif]![1]!;
    expect(f.ordre[f.espaceActif]![0]).toBe(a);
    await waitTitle(b, "Page B");
  });

  it("keeps a link opened in a space with its own profile in that space and container", async () => {
    const fenetreId = (await win()).id;
    await dispatch(m, { type: "creerEspace", nom: "Pro", icone: "💼", prive: false, profil: "nouveau", fenetreId });
    const esp = (await win()).espaceActif;
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(a, "#lien");
    const b = (await waitState((s) => s.fenetres[0]!.ordre[esp]!, (l) => l.length === 2))[1]!;
    await waitTitle(b, "Page B");
    expect((await state(m)).onglets[b]!.espaceId).toBe(esp);
    const ids = await m.execute<number[]>(
      "return arguments[0].map((id) => gBrowser.tabs.find((t) => t.getAttribute('webaios-tab-id') === id).userContextId)",
      [[a, b]],
    );
    expect(ids[0]).not.toBe(0);
    expect(ids[1]).toBe(ids[0]);
  });

  it("never turns Firefox's own tabs into WebAiOs tabs", async () => {
    expect(Object.keys((await state(m)).onglets)).toHaveLength(0);
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await dispatch(m, { type: "fermerOnglet", id: a });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(Object.keys((await state(m)).onglets)).toHaveLength(0);
    expect(await selected()).toEqual({ id: null, parking: true });
    expect(await markedTabs()).toBe(0);
    // Closing the parking tab itself: Firefox's replacement tab parks the window, it is no WebAiOs tab.
    await m.execute("gBrowser.removeTab(gBrowser.selectedTab)");
    await new Promise((r) => setTimeout(r, 500));
    expect(Object.keys((await state(m)).onglets)).toHaveLength(0);
    expect(await m.execute("return gBrowser.tabs.length")).toBe(1);
    expect(await selected()).toEqual({ id: null, parking: true });
  });

  it("closing the active tab removes its XUL tab and shows the next one", async () => {
    const a = await open("/a.html");
    const b = await open("/b.html");
    await waitTitle(b, "Page B");
    await dispatch(m, { type: "activerOnglet", id: a });
    await waitTitle(a, "Page A");
    expect(await markedTabs()).toBe(2);
    await dispatch(m, { type: "fermerOnglet", id: a });
    expect(await markedTabs()).toBe(1);
    expect((await selected()).id).toBe(b);
  });

  it("switching spaces shows the active tab of each space", async () => {
    const first = (await win()).espaceActif;
    const a = await open("/a.html");
    await dispatch(m, { type: "creerEspace", nom: "Pro", icone: "💼", prive: false, profil: "defaut", fenetreId: (await win()).id });
    const b = await open("/b.html");
    expect((await selected()).id).toBe(b);
    await dispatch(m, { type: "activerEspace", fenetreId: (await win()).id, id: first });
    expect((await selected()).id).toBe(a);
  });

  it("isolates the cookies of a profile, and wipes them with its last space", async () => {
    const fenetreId = (await win()).id;
    const spaceA = (await win()).espaceActif;
    await waitTitle(await open("/cookie"), "cookie");
    await dispatch(m, { type: "creerEspace", nom: "B", icone: "🅱", prive: false, profil: "nouveau", fenetreId });
    const spaceB = (await win()).espaceActif;
    const profileB = (await state(m)).espaces.find((e) => e.id === spaceB)!.profil;
    await waitTitle(await open("/lire-cookie"), "aucun");
    await waitTitle(await open("/cookie"), "cookie");
    const containerB = await m.execute<number>("return gBrowser.selectedTab.userContextId");
    const cookiesB = `return Services.cookies.getCookiesWithOriginAttributes(JSON.stringify({ userContextId: ${containerB} })).length`;
    expect(await m.execute(cookiesB)).toBe(1);
    await dispatch(m, { type: "activerEspace", fenetreId, id: spaceA });
    await waitTitle(await open("/lire-cookie"), "essai=1");
    await dispatch(m, { type: "supprimerEspace", id: spaceB });
    await waitFor(m, cookiesB, (n) => n === 0, 3_000);
    await dispatch(m, { type: "creerEspace", nom: "C", icone: "©", prive: false, profil: "nouveau", fenetreId });
    await waitTitle(await open("/lire-cookie"), "aucun");
    const names = await m.execute<string[]>(`
      const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
      return ContextualIdentityService.getPublicIdentities().map((i) => i.name);`);
    expect(names).not.toContain(`webaios-${profileB}`);
  });

  it("drops a page that closes itself", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    // popup-fermer.html calls window.close() 300 ms after loading.
    await inPage(a, "window.open('popup-fermer.html'); return 0");
    await waitState((s) => Object.keys(s.onglets).length, (n) => n === 2, 5_000);
    await waitState((s) => Object.keys(s.onglets), (ids) => ids.length === 1 && ids[0] === a, 5_000);
    expect(await markedTabs()).toBe(1);
  });

  it("opens a window.open popup with dimensions as a separate window", async () => {
    const a = await open("/popup.html");
    await waitTitle(a, "Popup source");
    await click(a, "#ouvrir-reste");
    const popups = await waitFor<boolean[]>(
      m,
      "return [...Services.wm.getEnumerator('navigator:browser')].map((w) => w.document.documentElement.hasAttribute('webaios-main'))",
      (v) => v.length === 2,
    );
    expect(popups.sort()).toEqual([false, true]);
    await new Promise((r) => setTimeout(r, 500));
    expect(Object.keys((await state(m)).onglets)).toEqual([a]);
  });
});
