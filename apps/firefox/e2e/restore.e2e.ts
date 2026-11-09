import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import { dispatch, inWindow, newWindow, state, waitFor, waitReady, waitWindowCount, windowHandles } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, pressKeys, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let dataDir: string;
let profile: string;
let w: LaunchedWebAiOs | undefined;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
afterEach(async () => {
  await w?.close();
  w = undefined;
  await rm(dataDir, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
});

/** Launches on the shared dataDir/profile (created on first use) and waits until the window has loaded its state. */
async function start(): Promise<Marionette> {
  dataDir ??= await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  profile ??= await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  w = await launchWebAiOs({ dataDir, profile });
  const m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"barre-laterale\"]')");
  return m;
}
/** Quits the way a user would, then forgets the instance (the folders stay for the next start). */
async function quit(): Promise<void> {
  await w!.close();
  w = undefined;
}
const win = async (m: Marionette) => (await state(m)).windows[0]!;
const marked = (m: Marionette) => m.execute<number>("return gBrowser.tabs.filter((t) => t.hasAttribute('webaios-tab-id')).length");

// Each test starts from fresh folders.
const fresh = () => {
  dataDir = undefined as never;
  profile = undefined as never;
};

describe("restore at startup", () => {
  it("restores tabs, spaces, pins, essentials and the active tab of each space", async () => {
    fresh();
    let m = await start();
    const windowId = (await win(m)).id;
    const open = async (p: string, enable = false) => {
      const before = new Set(Object.keys((await state(m)).tabs));
      const after = await dispatch(m, { type: "ouvrirOnglet", windowId: windowId, url: server.url + p, activate: enable });
      return Object.keys(after.tabs).find((id) => !before.has(id))!;
    };
    const a = await open("/a.html");
    const b = await open("/b.html");
    await open("/texte.html", true);
    await dispatch(m, { type: "epinglerOnglet", id: a });
    await dispatch(m, { type: "ajouterEssentiel", id: b });
    await dispatch(m, { type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: windowId } as Action);
    const work = (await state(m)).spaces.find((e) => e.name === "Boulot")!;
    const c = await open("/b.html?n=1", true);
    await newWindow(m);
    const before = await state(m);
    await quit();

    m = await start();
    // Both windows come back, and no third one appears while the second is still opening (Review Focus 1 and 3).
    const handles = await waitWindowCount(m, 2);
    await new Promise((r) => setTimeout(r, 2000));
    expect(await windowHandles(m)).toHaveLength(2);
    const after = await state(m);
    expect(after.windows).toHaveLength(2);
    // Each window gets its own active space back: the first one is on Boulot, with its tab.
    const seen: { handle: string; id: string; pair: unknown }[] = [];
    for (const handle of handles)
      seen.push(
        await inWindow(m, handle, async () => {
          await waitReady(m);
          const id = await m.execute<string>("return window.webaiosWindow.fenetreId");
          const pair = await inUi(m, `return [doc.querySelector('[data-testid^="espace-"][aria-current="true"]')?.textContent.trim(), doc.querySelectorAll('[data-testid^="onglet-"]').length]`);
          return { handle, id, pair };
        }),
      );
    expect(seen.map((x) => x.pair)).toContainEqual(["💼", 1]);
    // The checks below are on the first state window, whichever window Marionette started on.
    await m.command("WebDriver:SwitchToWindow", { handle: seen.find((x) => x.id === after.windows[0]!.id)!.handle, focus: false });
    expect(after.spaces.map((e) => [e.name, e.icon, e.pinned.length])).toEqual(before.spaces.map((e) => [e.name, e.icon, e.pinned.length]));
    expect(after.essentials).toEqual(before.essentials);
    const f = after.windows[0]!;
    expect(f.activeSpace).toBe(work.id);
    expect(f.active).toEqual(before.windows[0]!.active);
    expect(f.active[work.id]).toBe(c);
    expect(f.order).toEqual(before.windows[0]!.order);
    const urls = (s: typeof before) => Object.fromEntries(Object.values(s.tabs).map((o) => [o.id, o.url]));
    expect(urls(after)).toEqual(urls(before));
    // The active tab of the active space is displayed, on its page.
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('webaios-tab-id')", (v) => v === c);
    await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (v) => v === server.url + "/b.html?n=1");
    // Pages loaded in this run keep their URL at the next start too (no about:blank written back while quitting).
    await quit();
    m = await start();
    expect(urls(await state(m))).toEqual(urls(before));
  });

  it("a window's size is recorded and restored", async () => {
    fresh();
    let m = await start();
    const windowId = (await win(m)).id;
    await m.execute("window.resizeTo(1000, 700)");
    const width = `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready).state.fenetres.find((f) => f.id === ${JSON.stringify(windowId)})?.cadre?.largeur)();`;
    await waitFor(m, width, (v) => v === 1000);
    await quit();

    m = await start();
    await waitFor(m, "return [window.outerWidth, window.outerHeight]", (v: number[]) => v[0] === 1000 && v[1] === 700);
  });

  it("keeps a cookie set by a local server, in the space's own container found by name", async () => {
    fresh();
    let m = await start();
    const windowId = (await win(m)).id;
    await dispatch(m, { type: "creerEspace", name: "Propre", icon: "🔒", private: false, profile: "nouveau", windowId: windowId } as Action);
    const open = async (p: string) => {
      const before = new Set(Object.keys((await state(m)).tabs));
      const after = await dispatch(m, { type: "ouvrirOnglet", windowId: windowId, url: server.url + p });
      return Object.keys(after.tabs).find((id) => !before.has(id))!;
    };
    const title = (id: string, t: string) => waitFor(m, `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready).state.onglets[${JSON.stringify(id)}]?.titre)();`, (v) => v === t);
    await title(await open("/cookie"), "cookie");
    await quit();

    m = await start();
    await title(await open("/lire-cookie"), "essai=1");
  });

  it("100 restored tabs: one marked XUL tab (the active one) besides the parking tab; activating another creates a second", async () => {
    fresh();
    let m = await start();
    const windowId = (await win(m)).id;
    await m.execute(
      `return (async () => {
        const store = await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready;
        for (let i = 0; i < 100; i++) store.dispatch({ type: "ouvrirOnglet", fenetreId: arguments[0], url: arguments[1] + "/b.html?n=" + i, activer: i === 99 });
        await store.flush();
      })();`,
      [windowId, server.url],
    );
    expect(await marked(m)).toBe(1);
    await quit();

    m = await start();
    const f = await win(m);
    expect(f.order[f.activeSpace]).toHaveLength(100);
    expect(await marked(m)).toBe(1);
    expect(await m.execute<number>("return gBrowser.tabs.length")).toBe(2);
    await dispatch(m, { type: "activerOnglet", id: f.order[f.activeSpace]![0]! });
    await waitFor(m, "return gBrowser.tabs.filter((t) => t.hasAttribute('webaios-tab-id')).length", (n) => n === 2);
  });

  it("keeps the chosen search engine and uses it from ⌘T", async () => {
    fresh();
    let m = await start();
    await dispatch(m, { type: "choisirMoteur", engine: "duckduckgo" });
    await quit();

    m = await start();
    expect((await state(m)).settings.engine).toBe("duckduckgo");
    // No network in tests: watch the requests and cancel them.
    await m.execute(`
      window.webaiosRequests = [];
      Services.obs.addObserver({ observe(ch) { ch.QueryInterface(Ci.nsIChannel); if (ch.URI.host === "duckduckgo.com") { window.webaiosRequests.push(ch.URI.spec); ch.cancel(Cr.NS_ERROR_ABORT); } } }, "http-on-modify-request");
    `);
    await pressKeys(m, "Meta+t");
    await waitUi(m, "return doc.activeElement?.dataset.testid === 'saisie-commande'");
    await inUi(m, `const f = doc.activeElement; f.value = "chat"; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`);
    await pressKeys(m, "Enter");
    await waitFor(m, "return window.webaiosRequests", (r: string[]) => r.includes("https://duckduckgo.com/?q=chat"));
  });

  it("a change made right before quitting survives (no wait for the 500 ms recorder)", async () => {
    fresh();
    let m = await start();
    await dispatch(m, { type: "choisirMoteur", engine: "qwant" });
    await quit(); // straight after the dispatch
    m = await start();
    expect((await state(m)).settings.engine).toBe("qwant");
  });

  it("a v1 session (before configurable spaces) gets its tabs and essential back, and is rewritten as v2", async () => {
    fresh();
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
    const tab = (id: string, url: string, link: unknown = null) => ({ id, windowId: "f1", spaceId: "e1", url, title: id, favicon: null, link: link, openedByAgent: false, zoom: 1 });
    const v1 = {
      version: 1,
      spaces: [{ id: "e1", name: "Perso", icon: "🏠", pinned: [] }],
      essentials: [{ id: "fav-c", url: `${server.url}/texte.html`, title: "Texte", favicon: null }],
      tabs: {
        "o-a": tab("o-a", `${server.url}/a.html`),
        "o-b": tab("o-b", `${server.url}/b.html`),
        "o-c": tab("o-c", `${server.url}/texte.html`, { type: "essentiel", id: "fav-c" }),
      },
      windows: [
        { id: "f1", activeSpace: "e1", order: { e1: ["o-a", "o-b"] }, active: { e1: "o-b" }, compact: false, agentPanelOpen: false, recentlyClosed: [], frame: null },
      ],
      settings: { engine: "google", agentProfile: "claude", agentPanelWidth: 420 },
    };
    const file = path.join(dataDir, "session.json");
    await writeFile(file, JSON.stringify(v1));
    const m = await start();
    await waitUi(m, "return doc.querySelectorAll('[data-testid^=\"onglet-\"]').length === 2");
    await waitFor(m, "return gBrowser.selectedBrowser.contentTitle", (t) => t === "Page B");
    const read = async () => JSON.parse(await readFile(file, "utf8"));
    for (const end = Date.now() + 10_000; (await read()).version !== 2; await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > end) throw new Error("the session was not rewritten as v2");
    const written = await read();
    expect(written.profils).toEqual([{ id: "defaut" }]);
    expect(Object.keys(written.onglets).sort()).toEqual(["o-a", "o-b", "o-c"]);
    expect(written.essentiels).toEqual(v1.essentials);
    expect(written.onglets["o-c"].lien).toEqual({ type: "essentiel", id: "fav-c" });
    // The essential opens on its tab from before, in the default container.
    await click(m, '[data-testid="favori-fav-c"]');
    const shown = await waitFor<{ url: string; title: string; ctx: number }>(
      m,
      "return { url: gBrowser.selectedBrowser.currentURI.spec, title: gBrowser.selectedBrowser.contentTitle, ctx: gBrowser.selectedTab.userContextId }",
      (v) => v.title === "Texte",
    );
    expect(shown).toEqual({ url: `${server.url}/texte.html`, title: "Texte", ctx: 0 });
    expect(Object.keys((await state(m)).tabs)).toHaveLength(3);
  });

  it("an unreadable session: one notification, with the .corrompu path", async () => {
    fresh();
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
    await writeFile(path.join(dataDir, "session.json"), "{ not json");
    const m = await start();
    const aside = (await readdir(dataDir)).find((n) => n.endsWith(".corrompu"))!;
    const text = await waitFor<string[]>(
      m,
      `return (async () => { const nb = window.gNotificationBox; return [...nb.allNotifications].filter((n) => n.getAttribute("value") === "webaios-session-set-aside").map((n) => n.label?.textContent ?? n.messageText?.textContent ?? n.label ?? ""); })();`,
      (v) => v.length > 0,
    );
    await new Promise((r) => setTimeout(r, 500)); // a duplicate would show up by now
    const again = await m.execute<number>(`return [...window.gNotificationBox.allNotifications].filter((n) => n.getAttribute("value") === "webaios-session-set-aside").length`);
    expect(again).toBe(1);
    expect(text).toHaveLength(1);
    expect(text[0]).toContain(path.join(dataDir, aside));
    expect(text[0]).toContain("WebAiOs repart avec une session neuve");
  });
});
