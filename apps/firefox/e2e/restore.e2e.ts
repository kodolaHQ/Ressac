import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import { dispatch, inWindow, newWindow, state, waitFor, waitReady, waitWindowCount, windowHandles } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, noticeCount, pressKeys, visibleNotice, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let dataDir: string;
let profile: string;
let w: LaunchedRessac | undefined;
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
  dataDir ??= await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
  profile ??= await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  w = await launchRessac({ dataDir, profile });
  const m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
  return m;
}
/** Quits the way a user would, then forgets the instance (the folders stay for the next start). */
async function quit(): Promise<void> {
  await w!.close();
  w = undefined;
}
const win = async (m: Marionette) => (await state(m)).windows[0]!;
const marked = (m: Marionette) => m.execute<number>("return gBrowser.tabs.filter((t) => t.hasAttribute('ressac-tab-id')).length");

// Each test starts from fresh folders.
const fresh = () => {
  dataDir = undefined as never;
  profile = undefined as never;
};

describe("restore at startup", () => {
  it("startOnHome: the next launch shows the home page, the tabs still in the list", async () => {
    fresh();
    let m = await start();
    const after = await dispatch(m, { type: "openTab", windowId: (await win(m)).id, url: server.url + "/a.html", activate: true });
    const tab = Object.keys(after.tabs)[0]!;
    expect((await win(m)).active[(await win(m)).activeSpace]).toBe(tab);
    await dispatch(m, { type: "setStartOnHome", enabled: true });
    await quit();
    m = await start();
    const f = await win(m);
    expect(f.active[f.activeSpace]).toBeNull();
    expect(f.order[f.activeSpace]).toEqual([tab]);
    await waitUi(m, `return !!doc.querySelector('[data-testid="empty-page"]') && !!doc.querySelector('[data-testid="tab-${tab}"]')`);
  });

  it("restores tabs, spaces, pins, essentials and the active tab of each space", async () => {
    fresh();
    let m = await start();
    const windowId = (await win(m)).id;
    const open = async (p: string, enable = false) => {
      const before = new Set(Object.keys((await state(m)).tabs));
      const after = await dispatch(m, { type: "openTab", windowId: windowId, url: server.url + p, activate: enable });
      return Object.keys(after.tabs).find((id) => !before.has(id))!;
    };
    const a = await open("/a.html");
    const b = await open("/b.html");
    await open("/texte.html", true);
    await dispatch(m, { type: "pinTab", id: a });
    await dispatch(m, { type: "addEssential", id: b });
    await dispatch(m, { type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: windowId } as Action);
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
          const id = await m.execute<string>("return window.ressacWindow.windowId");
          const pair = await inUi(m, `return [doc.querySelector('[data-testid^="space-"][aria-current="true"]')?.title, doc.querySelectorAll('[data-testid^="tab-"]').length]`);
          return { handle, id, pair };
        }),
      );
    expect(seen.map((x) => x.pair)).toContainEqual(["Boulot", 1]);
    // The checks below are on the first state window, whichever window Marionette started on.
    await m.command("WebDriver:SwitchToWindow", { handle: seen.find((x) => x.id === after.windows[0]!.id)!.handle, focus: false });
    expect(after.spaces.map((e) => [e.name, e.icon, e.pinned.length])).toEqual(before.spaces.map((e) => [e.name, e.icon, e.pinned.length]));
    expect(after.essentials).toEqual(before.essentials);
    const f = after.windows[0]!;
    expect(f.activeSpace).toBe(work.id);
    expect(f.active).toEqual(before.windows[0]!.active);
    expect(f.active[work.id]).toBe(c);
    expect(f.order).toEqual(before.windows[0]!.order);
    // The second window comes back under a new id: its only tab, the essential it keeps loaded, is a new one.
    const urls = (s: typeof before) => Object.fromEntries(Object.values(s.tabs).filter((o) => o.windowId === s.windows[0]!.id).map((o) => [o.id, o.url]));
    expect(Object.values(after.tabs).filter((o) => o.windowId === after.windows[1]!.id).map((o) => o.link?.type)).toEqual(["essential"]);
    expect(urls(after)).toEqual(urls(before));
    // The essential loads at launch, without being shown.
    await waitFor(m, `const t = gBrowser.tabs.find((t) => t.getAttribute('ressac-tab-id') === ${JSON.stringify(b)}); return !!t && !t.selected && t.linkedBrowser.currentURI.spec.endsWith('/b.html')`, (v) => v === true);
    // The active tab of the active space is displayed, on its page.
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('ressac-tab-id')", (v) => v === c);
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
    const width = `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready).state.windows.find((f) => f.id === ${JSON.stringify(windowId)})?.frame?.width)();`;
    await waitFor(m, width, (v) => v === 1000);
    await quit();

    m = await start();
    await waitFor(m, "return [window.outerWidth, window.outerHeight]", (v: number[]) => v[0] === 1000 && v[1] === 700);
  });

  it("keeps a cookie set by a local server, in the space's own container found by name", async () => {
    fresh();
    let m = await start();
    const windowId = (await win(m)).id;
    await dispatch(m, { type: "createSpace", name: "Propre", icon: "🔒", private: false, profile: "new", windowId: windowId } as Action);
    const open = async (p: string) => {
      const before = new Set(Object.keys((await state(m)).tabs));
      const after = await dispatch(m, { type: "openTab", windowId: windowId, url: server.url + p });
      return Object.keys(after.tabs).find((id) => !before.has(id))!;
    };
    const title = (id: string, t: string) => waitFor(m, `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready).state.tabs[${JSON.stringify(id)}]?.title)();`, (v) => v === t);
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
        const store = await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready;
        for (let i = 0; i < 100; i++) store.dispatch({ type: "openTab", windowId: arguments[0], url: arguments[1] + "/b.html?n=" + i, activate: i === 99 });
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
    await dispatch(m, { type: "activateTab", id: f.order[f.activeSpace]![0]! });
    await waitFor(m, "return gBrowser.tabs.filter((t) => t.hasAttribute('ressac-tab-id')).length", (n) => n === 2);
  });

  it("keeps the chosen search engine and uses it from ⌘T", async () => {
    fresh();
    let m = await start();
    await dispatch(m, { type: "chooseEngine", engine: "duckduckgo" });
    await quit();

    m = await start();
    expect((await state(m)).settings.engine).toBe("duckduckgo");
    // No network in tests: watch the requests and cancel them.
    await m.execute(`
      window.ressacRequests = [];
      Services.obs.addObserver({ observe(ch) { ch.QueryInterface(Ci.nsIChannel); if (ch.URI.host === "duckduckgo.com") { window.ressacRequests.push(ch.URI.spec); ch.cancel(Cr.NS_ERROR_ABORT); } } }, "http-on-modify-request");
    `);
    await pressKeys(m, "Meta+t");
    await waitUi(m, "return doc.activeElement?.dataset.testid === 'command-input'");
    await inUi(m, `const f = doc.activeElement; f.value = "chat"; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`);
    await pressKeys(m, "Enter");
    await waitFor(m, "return window.ressacRequests", (r: string[]) => r.includes("https://duckduckgo.com/?q=chat"));
  });

  it("a change made right before quitting survives (no wait for the 500 ms recorder)", async () => {
    fresh();
    let m = await start();
    await dispatch(m, { type: "chooseEngine", engine: "qwant" });
    await quit(); // straight after the dispatch
    m = await start();
    expect((await state(m)).settings.engine).toBe("qwant");
  });

  it("an unreadable session: one visible sidebar card, with the .corrupt path; « D'accord » hides it for good", async () => {
    fresh();
    dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
    await writeFile(path.join(dataDir, "session.json"), "{ not json");
    const m = await start();
    const aside = (await readdir(dataDir)).find((n) => n.endsWith(".corrupt"))!;
    const text = await visibleNotice(m, "session-set-aside");
    expect(await noticeCount(m, "session-set-aside")).toBe(1);
    expect(text).toContain(path.join(dataDir, aside));
    expect(text).toContain("Ressac repart avec une session neuve");
    // « D'accord » in one window: gone there and in a window opened after.
    await click(m, '[data-notice="session-set-aside"] [data-testid="notice-ok"]');
    await waitUi(m, `return !doc.querySelector('[data-notice="session-set-aside"]')`);
    const other = await newWindow(m);
    expect(await inWindow(m, other, () => noticeCount(m, "session-set-aside"))).toBe(0);
  });
});
