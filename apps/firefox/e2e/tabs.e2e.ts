import { createServer, type AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import type { BrowserState } from "../shared/model";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click as clickUi, missingApi, pressKeys, waitUi } from "./ui";

const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
// Each test launches its own Ressac.
beforeEach(async () => {
  w = await launchRessac();
  m = w.marionette;
  await m.setContext("chrome");
  // The window controller is up once it has marked the parking tab.
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
});
afterEach(() => w?.close());

/** Dispatches `action` and returns the id of the tab it created. */
async function opened(action: Action): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const after = await dispatch(m, action);
  return Object.keys(after.tabs).find((id) => !before.has(id))!;
}

const win = async () => (await state(m)).windows[0]!;
const open = async (path: string, extra: Partial<Extract<Action, { type: "openTab" }>> = {}) =>
  opened({ type: "openTab", windowId: (await win()).id, url: server.url + path, ...extra });

function waitState<T>(read: (s: BrowserState) => T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
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
const waitTitle = (id: string, title: string) => waitState((s) => s.tabs[id]?.title, (t) => t === title);

const markedTabs = () => m.execute<number>("return gBrowser.tabs.filter((t) => t.hasAttribute('ressac-tab-id')).length");
const selected = () =>
  m.execute<{ id: string | null; parking: boolean }>(
    "return { id: gBrowser.selectedTab.getAttribute('ressac-tab-id'), parking: gBrowser.selectedTab.hasAttribute('ressac-parking') }",
  );

/** Runs `script` in the page of Ressac tab `id` (content context), then comes back to the chrome context. */
async function inPage<T>(id: string, script: string): Promise<T> {
  const handle = await m.execute<string>(
    `const t = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]);
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

const POPUPS = "[...Services.wm.getEnumerator('navigator:browser')].filter((w) => !w.document.documentElement.hasAttribute('ressac-main'))";

/** Runs `fn` in the content of the popup whose URL contains `url`, then comes back to the Ressac window. */
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

/** Kills the content process of Ressac tab `id`, as a crash would. */
const crash = (id: string) =>
  m.execute(
    `const b = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]).linkedBrowser;
     Cc["@mozilla.org/processtools-service;1"].getService(Ci.nsIProcessToolsService).crash(b.browsingContext.currentWindowGlobal.domProcess.osPid);`,
    [id],
  );
/** The text of the UI's content area (an expression for waitUi). */
const CONTENT_TEXT = `(doc.querySelector('[data-testid="content-zone"]')?.textContent ?? "")`;

const windowCount = () => m.execute<number>("return [...Services.wm.getEnumerator('navigator:browser')].length");

describe("window controller", () => {
  it("loads a tab opened by dispatch and reports its title", async () => {
    // Records every URL the state gives the tab: the XUL tab's initial about:blank must not leak into it.
    await m.execute(`window.urls = new Set(); window.ressacWindow.store.subscribe((s) => { for (const o of Object.values(s.tabs)) urls.add(o.url); });`);
    const id = await open("/a.html");
    await waitTitle(id, "Page A");
    await waitState((s) => s.tabs[id]!.loading, (c) => c === false);
    expect((await state(m)).tabs[id]!.url).toBe(server.url + "/a.html");
    expect(await m.execute("return [...window.urls]")).toEqual([server.url + "/a.html"]);
  });

  it("navigates like the address bar, and goes back", async () => {
    await m.execute("ressacWindow.navigate(null, arguments[0])", [server.url + "/a.html"]);
    const id = Object.keys((await state(m)).tabs)[0]!;
    await waitTitle(id, "Page A");
    await m.execute("ressacWindow.navigate(arguments[0], arguments[1])", [id, server.url + "/b.html"]);
    await waitTitle(id, "Page B");
    expect((await state(m)).tabs[id]!.canGoBack).toBe(true);
    await m.execute("ressacWindow.command(arguments[0], 'back')", [id]);
    await waitTitle(id, "Page A");
  });

  it("only gives the active tab a XUL tab", async () => {
    const a = await open("/a.html");
    await open("/b.html", { activate: false });
    expect(await markedTabs()).toBe(1);
    expect((await selected()).id).toBe(a);
    const b = (await win()).order[(await win()).activeSpace]![1]!;
    await dispatch(m, { type: "activateTab", id: b });
    await waitTitle(b, "Page B");
    expect(await markedTabs()).toBe(2);
    expect((await selected()).id).toBe(b);
  });

  it("opens a target=_blank link right after its source", async () => {
    const a = await open("/a.html");
    const after = await open("/plante.html", { activate: false });
    await waitTitle(a, "Page A");
    await click(a, "#lien");
    const f = await waitState((s) => s.windows[0]!, (f) => f.order[f.activeSpace]!.length === 3);
    const b = f.order[f.activeSpace]![1]!;
    expect([f.order[f.activeSpace]![0], f.order[f.activeSpace]![2]]).toEqual([a, after]);
    await waitTitle(b, "Page B");
  });

  it("closing the tab a target=_blank link opened shows the source page again, attached and painted", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(a, "#lien");
    const b = (await waitState((s) => s.windows[0]!, (f) => f.order[f.activeSpace]!.length === 2)).order[(await win()).activeSpace]![1]!;
    await waitTitle(b, "Page B");
    await m.execute("window.ressacWindow.closeTab(arguments[0])", [b]);
    await waitState((s) => Object.keys(s.tabs), (ids) => ids.join() === a);
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('ressac-tab-id')", (v) => v === a);
    // Painted: the link's text darkens some pixel of the page's top-left corner (a snapshot, as Marionette's screenshot).
    const corner = `const r = gBrowser.selectedBrowser.getBoundingClientRect();
      const c = await window.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(r.left, r.top, 120, 40), 1, "white");
      const d = new OffscreenCanvas(120, 40).getContext("2d");
      d.drawImage(c, 0, 0);
      return [...d.getImageData(0, 0, 120, 40).data].some((v, i) => i % 4 < 3 && v < 128);`;
    await waitFor(m, `return (async () => { ${corner} })()`, (v) => v === true);
  });

  it("keeps a link opened in a space with its own profile in that space and container", async () => {
    const windowId = (await win()).id;
    await dispatch(m, { type: "createSpace", name: "Pro", icon: "💼", private: false, profile: "new", windowId: windowId });
    const space = (await win()).activeSpace;
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(a, "#lien");
    const b = (await waitState((s) => s.windows[0]!.order[space]!, (l) => l.length === 2))[1]!;
    await waitTitle(b, "Page B");
    expect((await state(m)).tabs[b]!.spaceId).toBe(space);
    const ids = await m.execute<number[]>(
      "return arguments[0].map((id) => gBrowser.tabs.find((t) => t.getAttribute('ressac-tab-id') === id).userContextId)",
      [[a, b]],
    );
    expect(ids[0]).not.toBe(0);
    expect(ids[1]).toBe(ids[0]);
  });

  it("never turns Firefox's own tabs into Ressac tabs", async () => {
    expect(Object.keys((await state(m)).tabs)).toHaveLength(0);
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await dispatch(m, { type: "closeTab", id: a });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(Object.keys((await state(m)).tabs)).toHaveLength(0);
    expect(await selected()).toEqual({ id: null, parking: true });
    expect(await markedTabs()).toBe(0);
    // Closing the parking tab itself: Firefox's replacement tab parks the window, it is no Ressac tab.
    await m.execute("gBrowser.removeTab(gBrowser.selectedTab)");
    await new Promise((r) => setTimeout(r, 500));
    expect(Object.keys((await state(m)).tabs)).toHaveLength(0);
    expect(await m.execute("return gBrowser.tabs.length")).toBe(1);
    expect(await selected()).toEqual({ id: null, parking: true });
  });

  it("closing the active tab removes its XUL tab and shows the next one", async () => {
    const a = await open("/a.html");
    const b = await open("/b.html");
    await waitTitle(b, "Page B");
    await dispatch(m, { type: "activateTab", id: a });
    await waitTitle(a, "Page A");
    expect(await markedTabs()).toBe(2);
    await dispatch(m, { type: "closeTab", id: a });
    expect(await markedTabs()).toBe(1);
    expect((await selected()).id).toBe(b);
  });

  it("switching spaces shows the active tab of each space", async () => {
    const first = (await win()).activeSpace;
    const a = await open("/a.html");
    await dispatch(m, { type: "createSpace", name: "Pro", icon: "💼", private: false, profile: "default", windowId: (await win()).id });
    const b = await open("/b.html");
    expect((await selected()).id).toBe(b);
    await dispatch(m, { type: "activateSpace", windowId: (await win()).id, id: first });
    expect((await selected()).id).toBe(a);
  });

  it("isolates the cookies of a profile, and wipes them with its last space", async () => {
    const windowId = (await win()).id;
    const spaceA = (await win()).activeSpace;
    await waitTitle(await open("/cookie"), "cookie");
    await dispatch(m, { type: "createSpace", name: "B", icon: "🅱", private: false, profile: "new", windowId: windowId });
    const spaceB = (await win()).activeSpace;
    const profileB = (await state(m)).spaces.find((e) => e.id === spaceB)!.profile;
    await waitTitle(await open("/lire-cookie"), "aucun");
    await waitTitle(await open("/cookie"), "cookie");
    const containerB = await m.execute<number>("return gBrowser.selectedTab.userContextId");
    const cookiesB = `return Services.cookies.getCookiesWithOriginAttributes(JSON.stringify({ userContextId: ${containerB} })).length`;
    expect(await m.execute(cookiesB)).toBe(1);
    await dispatch(m, { type: "activateSpace", windowId: windowId, id: spaceA });
    await waitTitle(await open("/lire-cookie"), "essai=1");
    await dispatch(m, { type: "deleteSpace", id: spaceB });
    await waitFor(m, cookiesB, (n) => n === 0, 3_000);
    await dispatch(m, { type: "createSpace", name: "C", icon: "©", private: false, profile: "new", windowId: windowId });
    await waitTitle(await open("/lire-cookie"), "aucun");
    const gone = await m.execute<boolean>(`
      const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
      return !ContextualIdentityService.getPrivateIdentity("userContextIdInternal.webaios-" + arguments[0]);`, [profileB]);
    expect(gone).toBe(true);
  });

  it("drops a page that closes itself", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    // popup-fermer.html calls window.close() 300 ms after loading.
    await inPage(a, "window.open('popup-fermer.html'); return 0");
    await waitState((s) => Object.keys(s.tabs).length, (n) => n === 2, 5_000);
    await waitState((s) => Object.keys(s.tabs), (ids) => ids.length === 1 && ids[0] === a, 5_000);
    expect(await markedTabs()).toBe(1);
  });

  it("a tab Firefox closes itself keeps its space active", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    const windowId = (await win()).id;
    await dispatch(m, { type: "createSpace", name: "B", icon: "🅱", private: false, profile: "default", windowId: windowId });
    const spaceB = (await win()).activeSpace;
    const b = await open("/b.html");
    await waitTitle(b, "Page B");
    // As an add-on's tabs.remove: Firefox first selects a neighbour, here the other space's tab.
    await m.execute("gBrowser.removeTab(gBrowser.selectedTab)");
    await waitState((s) => !!s.tabs[b], (v) => !v);
    expect((await win()).activeSpace).toBe(spaceB);
    expect(await m.execute<boolean>("return gBrowser.selectedTab.hasAttribute('ressac-parking')")).toBe(true);
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
    expect(await m.execute("return !!window.ressacWindow")).toBe(true);
    expect(Object.keys((await state(m)).tabs)).toEqual([a]);
  });

  it("⇧click on a link opens a tab, not a window", async () => {
    const a = await open("/lien.html");
    await waitTitle(a, "Lien");
    await inPage(a, "return 0");
    await clickHere("#lien", true);
    await waitState((s) => Object.keys(s.tabs).length, (n) => n === 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(await windowCount()).toBe(1);
  });

  it("a popup shows its site even once its source tab and its opener are gone", async () => {
    const a = await open("/popup.html");
    await waitTitle(a, "Popup source");
    await click(a, "#ouvrir-reste");
    await waitFor(m, `return ${POPUPS}.length`, (n) => n === 1);
    await dispatch(m, { type: "closeTab", id: a });
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
    const other = await open("/a.html", { activate: false });
    await click(a, "#ouvrir-reste");
    await waitFor(m, `return ${POPUPS}.length`, (n) => n === 1);
    const host = new URL(server.url).host;
    await waitFor(m, `return ${POPUPS}[0].document.title`, (t) => t === `${host} — Connexion`);
    // Another tab shown meanwhile: the link still goes right after the popup's source.
    await dispatch(m, { type: "activateTab", id: other });
    await waitTitle(other, "Page A");
    await clickInPopup("popup-reste", "#lien-blank");
    const f = await waitState((s) => s.windows[0]!, (f) => f.order[f.activeSpace]!.length === 3);
    expect(f.order[f.activeSpace]![0]).toBe(a);
    expect(f.order[f.activeSpace]![2]).toBe(other);
    await waitTitle(f.order[f.activeSpace]![1]!, "Page B");
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
    const a = await open("/a.html", { activate: false });
    await waitUi(m, "return doc.querySelector('[data-testid=\"sidebar\"]').textContent.includes(arguments[0])", ["a.html"]);
    expect((await state(m)).tabs[a]).toBeDefined();
    await clickUi(m, '[data-testid="content-zone"] button', { text: "Recharger" });
    await waitUi(m, `return !${CONTENT_TEXT}.includes("Cette page a planté.")`);
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('ressac-tab-id')", (v) => v === id);
    await waitState((s) => s.tabs[id]?.crashed, (p) => p === false);
    await waitFor(m, "return gBrowser.selectedBrowser.contentTitle", (t) => t === "Plante");
    expect(await missingApi(m)).toEqual([]);
  });

  it("navigating a crashed tab elsewhere loads the new page in a new XUL tab", async () => {
    const id = await open("/plante.html");
    await waitTitle(id, "Plante");
    await crash(id);
    await waitUi(m, `return ${CONTENT_TEXT}.includes("Cette page a planté.")`);
    await m.execute("window.ressacWindow.navigate(arguments[0], arguments[1])", [id, server.url + "/a.html"]);
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('ressac-tab-id')", (v) => v === id);
    await waitFor(m, "return gBrowser.selectedBrowser.contentTitle", (t) => t === "Page A");
    await waitUi(m, `return !${CONTENT_TEXT}.includes("Cette page a planté.")`);
    expect((await state(m)).tabs[id]?.crashed).toBe(false);
  });

  it("an unreachable page shows an error message and Recharger", async () => {
    const id = await opened({ type: "openTab", windowId: (await win()).id, url: "http://127.0.0.1:1/" });
    const text = await waitUi<string>(m, `const t = ${CONTENT_TEXT}; return t.includes("Impossible d'ouvrir cette page.") && t;`);
    expect(text).toMatch(/NS_ERROR_[A-Z_]+/);
    expect(text).toContain("http://127.0.0.1:1/");
    await waitUi(m, "return [...doc.querySelectorAll('[data-testid=\"content-zone\"] button')].some((b) => b.textContent === 'Recharger')");
    expect(await selected()).toEqual({ id: null, parking: true });
    expect((await state(m)).tabs[id]?.loading).toBe(false);
    // A refused connection names its failed load's status (port 1 above is refused before any request).
    const closed = await new Promise<number>((resolve) => {
      const srv = createServer().listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as AddressInfo;
        srv.close(() => resolve(port));
      });
    });
    const refused = await opened({ type: "openTab", windowId: (await win()).id, url: `http://127.0.0.1:${closed}/` });
    await waitState((s) => s.tabs[refused]?.error, (e) => e === "NS_ERROR_CONNECTION_REFUSED");
    expect(await missingApi(m)).toEqual([]);
  });
});

describe("leaving a page with unsaved changes", () => {
  /** formulaire.html with its beforeunload armed, displayed. */
  async function unsavedForm(): Promise<string> {
    // Firefox only lets a page the user interacted with ask: a script's armer() is no interaction.
    await m.execute("Services.prefs.setBoolPref('dom.require_user_interaction_for_beforeunload', false)");
    const id = await open("/formulaire.html");
    await waitTitle(id, "Formulaire");
    await inPage(id, "armer(); return 0");
    return id;
  }

  /**
   * Runs a WebDriver alert command on the page of the browser `handle` (content context). A chrome-context script would
   * fail while the prompt is open: the handle is read before.
   */
  async function onAlert<T>(handle: string, command: "WebDriver:GetAlertText" | "WebDriver:DismissAlert" | "WebDriver:AcceptAlert"): Promise<T | null> {
    await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
    await m.setContext("content");
    try {
      return (await m.command<{ value: T }>(command)).value;
    } catch (e) {
      if (/no such alert/.test(String(e))) return null;
      throw e;
    } finally {
      await m.setContext("chrome");
    }
  }

  // Rester is button 1 (dismiss), Quitter button 0 (accept).
  for (const [label, button] of [["Rester", 1], ["Quitter", 0]] as const) {
    it(`closing a tab with an unsaved form asks (${label})`, async () => {
      // Marionette would dismiss the prompt at the next command: this session leaves prompts to the test.
      await m.command("WebDriver:DeleteSession");
      await m.command("WebDriver:NewSession", { unhandledPromptBehavior: "ignore" });
      await m.setContext("chrome");
      const id = await unsavedForm();
      const handle = await m.execute<string>(
        `return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]).linkedBrowser);`,
        [id],
      );
      await pressKeys(m, "Meta+w");
      const deadline = Date.now() + 5_000;
      let text: string | null = null;
      while (!(text = await onAlert<string>(handle, "WebDriver:GetAlertText")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(text).toContain("Les modifications que vous avez faites");
      await onAlert(handle, button === 1 ? "WebDriver:DismissAlert" : "WebDriver:AcceptAlert");
      await new Promise((r) => setTimeout(r, 500));
      expect(Object.keys((await state(m)).tabs)).toHaveLength(button === 1 ? 1 : 0);
      // Only one question: none is left open.
      if (button === 1) expect(await onAlert(handle, "WebDriver:GetAlertText")).toBeNull();
    });
  }

  it("closing a background tab with an unsaved form brings it to the front to ask; Rester puts the previous tab back", async () => {
    await m.command("WebDriver:DeleteSession");
    await m.command("WebDriver:NewSession", { unhandledPromptBehavior: "ignore" });
    await m.setContext("chrome");
    const id = await unsavedForm();
    const handle = await m.execute<string>(
      `return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]).linkedBrowser);`,
      [id],
    );
    const b = await open("/b.html");
    await waitTitle(b, "Page B");
    // Every active tab of the state, from here on: no chrome script runs while the prompt is open.
    await m.execute(`const c = window.ressacWindow;
      window.actives = [];
      c.store.subscribe((s) => { const f = s.windows.find((x) => x.id === c.windowId); window.actives.push(f.active[f.activeSpace]); });`);
    // The sidebar's close button on the form's row.
    await m.execute("window.ressacWindow.closeTab(arguments[0])", [id]);
    const deadline = Date.now() + 5_000;
    let text: string | null = null;
    while (!(text = await onAlert<string>(handle, "WebDriver:GetAlertText")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(text).toContain("Les modifications que vous avez faites");
    await onAlert(handle, "WebDriver:DismissAlert");
    // Asked in front, its own tab active in the state, then the previous one again.
    expect(await m.execute<string[]>("return [...new Set(window.actives)]")).toEqual([id, b]);
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('ressac-tab-id')", (v) => v === b);
    const after = await win();
    expect(after.active[after.activeSpace]).toBe(b);
    expect((await state(m)).tabs[id]).toBeDefined();
  });

  it("a page frozen in beforeunload is closed after 5 s", async () => {
    const id = await open("/frozen-unload.html");
    await waitTitle(id, "Figée");
    const start = Date.now();
    await pressKeys(m, "Meta+w");
    await waitState((s) => s.tabs[id], (o) => !o, 7_000);
    expect(Date.now() - start).toBeLessThan(7_000);
  });

  it("a crashed tab closes without asking", async () => {
    const id = await unsavedForm();
    await crash(id);
    await waitUi(m, `return ${CONTENT_TEXT}.includes("Cette page a planté.")`);
    await pressKeys(m, "Meta+w");
    await waitState((s) => s.tabs[id], (o) => !o, 2_000);
  });

  // Marionette accepts Firefox's own beforeunload prompts by itself: the test counts the dialogs that open.
  it("quitting asks nothing; closing the window still asks, as Firefox", async () => {
    await unsavedForm();
    // What every quit path does (nsAppStartup::Quit): quit-application-requested, then each window's CanClose, same task.
    const dialogs = (quitting: boolean) =>
      m.execute<number>(
        `let n = 0;
         const count = { observe: () => n++ };
         Services.obs.addObserver(count, "common-dialog-loaded");
         try {
           if (arguments[0]) Services.obs.notifyObservers(Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool), "quit-application-requested");
           window.CanCloseWindow();
         } finally {
           Services.obs.removeObserver(count, "common-dialog-loaded");
         }
         return n;`,
        [quitting],
      );
    expect(await dialogs(false)).toBe(1);
    expect(await dialogs(true)).toBe(0);
    // That quit never happened (no quit() after it, as when a window's page keeps it): closing the window asks again.
    expect(await dialogs(false)).toBe(1);
  });
});
