import { createServer, type AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import type { EtatNavigateur } from "../../navigateur/src/commun/modele";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click as clickUi, missingApi, waitUi } from "./ui";

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
  await clickHere(selector);
}

/** A trusted click (WebDriver actions, so a user gesture) on `selector` in the current content page, ⇧ held if `shift`. */
async function clickHere(selector: string, shift = false): Promise<void> {
  await m.setContext("content");
  try {
    const found = await m.command<{ value: Record<string, string> }>("WebDriver:FindElement", { using: "css selector", value: selector });
    const SHIFT = "\uE008";
    const keys = shift ? [{ type: "keyDown", value: SHIFT }, { type: "pause" }, { type: "pause" }, { type: "pause" }, { type: "keyUp", value: SHIFT }] : [];
    const pointer = [
      ...(shift ? [{ type: "pause" }] : []),
      { type: "pointerMove", origin: found.value, x: 0, y: 0 },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ];
    await m.command("WebDriver:PerformActions", {
      actions: [
        { type: "key", id: "kb", actions: keys },
        { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: pointer },
      ],
    });
    await m.command("WebDriver:ReleaseActions");
  } finally {
    await m.setContext("chrome");
  }
}

const POPUPS = "[...Services.wm.getEnumerator('navigator:browser')].filter((w) => !w.document.documentElement.hasAttribute('webaios-main'))";

/** Runs `fn` in the content of the popup whose URL contains `url`, then comes back to the WebAiOs window. */
async function inPopup<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  const handle = await m.execute<string>(
    `const b = ${POPUPS}.map((w) => w.gBrowser.selectedBrowser).find((b) => b.currentURI.spec.includes(arguments[0]));
     return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(b);`,
    [url],
  );
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  try {
    return await fn();
  } finally {
    await m.command("WebDriver:SwitchToWindow", { handle: main, focus: false });
  }
}

const clickInPopup = (url: string, selector: string) => inPopup(url, () => clickHere(selector));

/** Kills the content process of WebAiOs tab `id`, as a crash would. */
const crash = (id: string) =>
  m.execute(
    `const b = gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === arguments[0]).linkedBrowser;
     Cc["@mozilla.org/processtools-service;1"].getService(Ci.nsIProcessToolsService).crash(b.browsingContext.currentWindowGlobal.domProcess.osPid);`,
    [id],
  );
/** The text of the UI's content area (an expression for waitUi). */
const CONTENT_TEXT = `(doc.querySelector('[data-testid="zone-contenu"]')?.textContent ?? "")`;

const windowCount = () => m.execute<number>("return [...Services.wm.getEnumerator('navigator:browser')].length");

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

  it("opens a window.open popup with dimensions as a separate window; closing it keeps the app", async () => {
    const a = await open("/popup.html");
    await waitTitle(a, "Popup source");
    await click(a, "#ouvrir");
    // popup-fermer.html closes itself 300 ms after loading.
    await waitFor(m, `return ${POPUPS}.length`, (n) => n === 1);
    await waitFor(m, `return ${POPUPS}.length`, (n) => n === 0);
    await new Promise((r) => setTimeout(r, 500));
    expect(await windowCount()).toBe(1);
    expect(await m.execute("return !!window.webaiosWindow")).toBe(true);
    expect(Object.keys((await state(m)).onglets)).toEqual([a]);
  });

  it("⇧click on a link opens a tab, not a window", async () => {
    const a = await open("/lien.html");
    await waitTitle(a, "Lien");
    await inPage(a, "return 0");
    await clickHere("#lien", true);
    await waitState((s) => Object.keys(s.onglets).length, (n) => n === 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(await windowCount()).toBe(1);
  });

  it("a popup shows its site even once its source tab and its opener are gone", async () => {
    const a = await open("/popup.html");
    await waitTitle(a, "Popup source");
    await click(a, "#ouvrir-reste");
    await waitFor(m, `return ${POPUPS}.length`, (n) => n === 1);
    await dispatch(m, { type: "fermerOnglet", id: a });
    // Step 1 opens step 2, then closes itself.
    await inPopup("popup-reste", async () => {
      await m.setContext("content");
      try {
        await m.execute("window.open('a.html', 'etape2', 'width=400,height=500'); setTimeout(() => window.close(), 100); return 0");
      } finally {
        await m.setContext("chrome");
      }
    });
    await waitFor(m, "return " + POPUPS + ".map((w) => w.document.title)", (t: string[]) => t.length === 1 && t[0] === `${new URL(server.url).host} — Page A`);
  });

  it("an about:blank popup written by its opener shows about:blank, not only the title it was given", async () => {
    const a = await open("/popup.html");
    await waitTitle(a, "Popup source");
    await inPage(a, "const w = window.open('', 'ecrite', 'width=400,height=500'); w.document.write('<title>accounts.example.com</title>'); w.document.close(); return 0");
    await waitFor(m, "return " + POPUPS + ".map((w) => w.document.title)", (t: string[]) => t.length === 1 && t[0] === "about:blank — accounts.example.com");
  });

  it("popup: its title shows the site; a target=_blank link in it opens a tab; a further step stays a popup", async () => {
    const a = await open("/popup.html");
    await waitTitle(a, "Popup source");
    const other = await open("/a.html", { activer: false });
    await click(a, "#ouvrir-reste");
    await waitFor(m, `return ${POPUPS}.length`, (n) => n === 1);
    const host = new URL(server.url).host;
    await waitFor(m, `return ${POPUPS}[0].document.title`, (t) => t === `${host} — Connexion`);
    // Another tab shown meanwhile: the link still goes right after the popup's source.
    await dispatch(m, { type: "activerOnglet", id: other });
    await waitTitle(other, "Page A");
    await clickInPopup("popup-reste", "#lien-blank");
    const f = await waitState((s) => s.fenetres[0]!, (f) => f.ordre[f.espaceActif]!.length === 3);
    expect(f.ordre[f.espaceActif]![0]).toBe(a);
    expect(f.ordre[f.espaceActif]![2]).toBe(other);
    await waitTitle(f.ordre[f.espaceActif]![1]!, "Page B");
    expect(await windowCount()).toBe(2);
    // The next step (popup-fermer.html) closes itself 300 ms after loading: count the windows as each opens.
    await m.execute(`window.most = 0; Services.obs.addObserver((w) => w.addEventListener("load",
      () => (window.most = Math.max(window.most, [...Services.wm.getEnumerator("navigator:browser")].length)), { once: true }), "domwindowopened");`);
    await clickInPopup("popup-reste", "#sous-popup");
    await waitFor(m, "return window.most", (n) => n === 3);
  });

  it("a crashed page shows the message and Recharger works; the rest of the browser keeps running", async () => {
    const id = await open("/plante.html");
    await waitTitle(id, "Plante");
    await crash(id);
    await waitUi(m, `return ${CONTENT_TEXT}.includes("Cette page a planté.")`);
    expect(await selected()).toEqual({ id: null, parking: true });
    const a = await open("/a.html", { activer: false });
    await waitUi(m, "return doc.querySelector('[data-testid=\"barre-laterale\"]').textContent.includes(arguments[0])", ["a.html"]);
    expect((await state(m)).onglets[a]).toBeDefined();
    await clickUi(m, '[data-testid="zone-contenu"] button', { text: "Recharger" });
    await waitUi(m, `return !${CONTENT_TEXT}.includes("Cette page a planté.")`);
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('webaios-tab-id')", (v) => v === id);
    await waitState((s) => s.onglets[id]?.plante, (p) => p === false);
    await waitFor(m, "return gBrowser.selectedBrowser.contentTitle", (t) => t === "Plante");
    expect(await missingApi(m)).toEqual([]);
  });

  it("an unreachable page shows an error message and Recharger", async () => {
    const id = await opened({ type: "ouvrirOnglet", fenetreId: (await win()).id, url: "http://127.0.0.1:1/" });
    const text = await waitUi<string>(m, `const t = ${CONTENT_TEXT}; return t.includes("Impossible d'ouvrir cette page.") && t;`);
    expect(text).toMatch(/NS_ERROR_[A-Z_]+/);
    expect(text).toContain("http://127.0.0.1:1/");
    await waitUi(m, "return [...doc.querySelectorAll('[data-testid=\"zone-contenu\"] button')].some((b) => b.textContent === 'Recharger')");
    expect(await selected()).toEqual({ id: null, parking: true });
    expect((await state(m)).onglets[id]?.chargement).toBe(false);
    // A refused connection names its failed load's status (port 1 above is refused before any request).
    const closed = await new Promise<number>((resolve) => {
      const srv = createServer().listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as AddressInfo;
        srv.close(() => resolve(port));
      });
    });
    const refused = await opened({ type: "ouvrirOnglet", fenetreId: (await win()).id, url: `http://127.0.0.1:${closed}/` });
    await waitState((s) => s.onglets[refused]?.erreur, (e) => e === "NS_ERROR_CONNECTION_REFUSED");
    expect(await missingApi(m)).toEqual([]);
  });
});
