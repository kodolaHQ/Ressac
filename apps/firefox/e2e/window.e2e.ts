import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatch, inWindow, newWindow as newWindowIn, pressClosing as pressClosingIn, state, waitFor, waitReady as waitReadyIn, waitWindowCount, windowHandles } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inUi, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
const waitReady = () => waitReadyIn(m);
beforeEach(async () => {
  w = await launchRessac();
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady();
});
afterEach(() => w?.close());

const windowId = async () => (await state(m)).windows[0]!.id;
const handle = async () => (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pressClosing = (combo: string) => pressClosingIn(m, combo);
async function openTab(win: string, path: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const after = await dispatch(m, { type: "openTab", windowId: win, url: server.url + path });
  return Object.keys(after.tabs).find((x) => !before.has(x))!;
}
const newWindow = () => newWindowIn(m);
/**
 * Closes the only window, then, from a module timer (Marionette has no window to run in meanwhile): counts the browser
 * windows, dispatches `chooseEngine`, counts again 300 ms later into the pref `ressac.test.closed`, and runs `reopen`.
 */
async function closeLastWindow(reopen: string): Promise<{ closed: number; afterEngine: number }> {
  const old = await handle();
  await m.execute(
    `return (async () => {
      const store = await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready;
      const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
      const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
      const count = () => [...Services.wm.getEnumerator("navigator:browser")].length;
      window.close();
      setTimeout(() => {
        const closed = count();
        store.dispatch({ type: "chooseEngine", engine: "qwant" });
        setTimeout(() => {
          Services.prefs.setStringPref("ressac.test.closed", JSON.stringify({ closed, afterEngine: count() }));
          ${reopen};
        }, 300);
      }, 500);
    })();`,
  );
  const reopened = (await waitWindowCount(m, 1)).find((h) => h !== old);
  if (!reopened) throw new Error("the window was not reopened");
  await m.command("WebDriver:SwitchToWindow", { handle: reopened, focus: false });
  await waitReady();
  return JSON.parse(await m.execute<string>(`return Services.prefs.getStringPref("ressac.test.closed")`));
}

describe("the Ressac window", () => {
  it("⌘N opens a second Ressac window on the active space, with its own sidebar", async () => {
    const first = await windowId();
    const s = await dispatch(m, { type: "createSpace", name: "Travail", icon: "💼", private: false, profile: "default", windowId: first });
    const space = s.spaces.at(-1)!.id;
    expect(s.windows[0]!.activeSpace).toBe(space);
    const other = await newWindow();
    const after = await state(m);
    expect(after.windows).toHaveLength(2);
    const id = await inWindow(m, other, async () => {
      expect(await m.execute("return document.documentElement.hasAttribute('ressac-main')")).toBe(true);
      return m.execute<string>("return window.ressacWindow.windowId");
    });
    expect(id).not.toBe(first);
    expect(after.windows.find((f) => f.id === id)!.activeSpace).toBe(space);
    // Its sidebar acts on its own window.
    const tab = await openTab(id, "/a.html");
    await inWindow(m, other, () => waitUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="tab-${tab}"]`]));
    expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="tab-${tab}"]`])).toBe(false);
  });

  it("⇧⌘W closes one window among two: it leaves the state, its tabs move to the other window", async () => {
    const first = await windowId();
    const other = await newWindow();
    const id = await inWindow(m, other, () => m.execute<string>("return window.ressacWindow.windowId"));
    const tab = await openTab(id, "/a.html");
    await inWindow(m, other, async () => {
      await waitFor(m, "return gBrowser.selectedTab.getAttribute('ressac-tab-id')", (v) => v === tab);
      await pressClosing("Meta+Shift+w");
    });
    await waitWindowCount(m, 1);
    const after = await state(m);
    expect(after.windows[0]!.id).toBe(first);
    expect(after.tabs[tab]?.windowId).toBe(first);
    expect(after.windows[0]!.order[after.tabs[tab]!.spaceId]).toContain(tab);
    // Shown in the remaining window, its page comes back (a XUL tab is only made for the displayed tab).
    await dispatch(m, { type: "activateTab", id: tab });
    await waitFor(m, `return gBrowser.tabs.some((t) => t.getAttribute('ressac-tab-id') === ${JSON.stringify(tab)})`, (v) => v === true);
  });

  it("macOS: closing the last window keeps the app and its tabs in the state; no XUL tab is left; chooseEngine does not reopen it; the Dock reopens it with its tabs listed", async () => {
    const id = await windowId();
    const tab = await openTab(id, "/a.html");
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('ressac-tab-id')", (v) => v === tab);
    // A module timer outlives the closing window: it opens the new one as the Dock would.
    const counts = await closeLastWindow("BrowserWindowTracker.openWindow()");
    // No window, so no XUL tab: the page closed with it.
    expect(counts).toEqual({ closed: 0, afterEngine: 0 });
    const s = await state(m);
    expect(s.settings.engine).toBe("qwant");
    expect(s.windows.map((f) => f.id)).toEqual([id]);
    expect(await m.execute("return window.ressacWindow.windowId")).toBe(id);
    await waitUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="tab-${tab}"]`]);
    // It still follows the store.
    const next = await openTab(id, "/b.html");
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('ressac-tab-id')", (v) => v === next);
  });

  it("with no window open, OpenBrowserWindow (the hidden window's ⌘N) brings the closed window back, and no second one", async () => {
    const id = await windowId();
    await closeLastWindow("Services.appShell.hiddenDOMWindow.OpenBrowserWindow()");
    await sleep(300);
    expect(await windowHandles(m)).toHaveLength(1);
    expect(await m.execute("return window.ressacWindow.windowId")).toBe(id);
    expect((await state(m)).windows.map((f) => f.id)).toEqual([id]);
  });

  it("⌘W on the empty page of a window without tabs closes it; the app stays", async () => {
    await pressClosing("Meta+w");
    await waitWindowCount(m, 0);
    await sleep(300);
    // Firefox still runs and answers.
    expect(await windowHandles(m)).toEqual([]);
    expect(() => process.kill(w.pid, 0)).not.toThrow();
  });

  it("a private window is never Ressac, with a Ressac window open or after the last one closed", async () => {
    const id = await windowId();
    const old = await handle();
    const notRessac = "return [document.documentElement.hasAttribute('ressac-main'), !!window.ressacWindow]";
    await m.execute("OpenBrowserWindow({ private: true })");
    const priv = (await waitWindowCount(m, 2)).find((h) => h !== old)!;
    await inWindow(m, priv, async () => {
      await m.execute("return delayedStartupPromise.then(() => new Promise((r) => setTimeout(r, 500)))");
      expect(await m.execute(notRessac)).toEqual([false, false]);
      await m.execute("window.close()");
    });
    await waitWindowCount(m, 1);
    expect((await state(m)).windows.map((f) => f.id)).toEqual([id]);
    // The last window closed: the hidden window's ⇧⌘P opens a private window, which must not take the kept one.
    await m.execute(
      `return (async () => {
        const store = await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready;
        const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
        const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
        window.close();
        setTimeout(() => {
          const p = Services.appShell.hiddenDOMWindow.OpenBrowserWindow({ private: true });
          // Its delayedStartupPromise does not exist yet: give it time to start (and to claim, if it would).
          setTimeout(() => {
            Services.prefs.setStringPref("ressac.test.private", JSON.stringify({
              adopted: p.document.documentElement.hasAttribute("ressac-main"),
              windows: store.state.windows.map((f) => f.id),
            }));
            p.close();
            BrowserWindowTracker.openWindow();
          }, 2000);
        }, 500);
      })();`,
    );
    // The private window shows alone for a while: wait for the Ressac one.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const handles = await windowHandles(m);
      if (handles.length === 1 && handles[0] !== old && handles[0] !== priv) {
        // The private window may close between the list and the switch: it is not the one awaited.
        const there = await m.command("WebDriver:SwitchToWindow", { handle: handles[0], focus: false }).then(() => true, () => false);
        if (there && (await m.execute("return !!window.ressacWindow").catch(() => false))) break;
      }
      if (Date.now() > deadline) throw new Error("the Ressac window did not come back");
      await sleep(100);
    }
    expect(JSON.parse(await m.execute<string>(`return Services.prefs.getStringPref("ressac.test.private")`))).toEqual({ adopted: false, windows: [id] });
    // The kept window was not consumed: the next window takes it back.
    expect(await m.execute("return window.ressacWindow.windowId")).toBe(id);
    expect((await state(m)).windows.map((f) => f.id)).toEqual([id]);
  });

  it("Firefox's menu commands add no tabs; New Window and Close Window lead to Ressac windows", async () => {
    const tab = await openTab(await windowId(), "/a.html");
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('ressac-tab-id')", (v) => v === tab);
    // doCommand ignores "disabled": that is the path a stray caller takes; no Ressac tab may come of it.
    for (const cmd of ["cmd_newNavigatorTab", "menu_newNavigatorTab"]) await m.execute("document.getElementById(arguments[0]).doCommand()", [cmd]);
    await sleep(500);
    expect(Object.keys((await state(m)).tabs)).toEqual([tab]);
    expect(await m.execute("return gBrowser.selectedTab.getAttribute('ressac-tab-id')")).toBe(tab);
    // macOS's native menu item is enabled from its command's "disabled" (nsMenuItemX::SetEnabled); headless has no native menu.
    const items = ["menu_newNavigatorTab", "menu_newNavigator", "menu_newPrivateWindow", "menu_close", "menu_closeWindow", "menu_preferences"];
    const enabled = `return arguments[0].filter((id) => {
      const item = document.getElementById(id);
      return !(document.getElementById(item.getAttribute("command")) ?? item).hasAttribute("disabled");
    })`;
    expect(await m.execute(enabled, [items])).toEqual(["menu_newNavigator", "menu_closeWindow", "menu_preferences"]);
    // The Settings item opens our page, never about:preferences.
    await m.execute("document.getElementById('menu_preferences').doCommand()");
    await expect.poll(async () => Object.values((await state(m)).tabs).filter((o) => o.url === "ressac://settings")).toHaveLength(1);
    expect(await m.execute<number>("return gBrowser.tabs.filter((t) => t.linkedBrowser.currentURI.spec.startsWith('about:preferences')).length")).toBe(0);
    const old = await handle();
    await m.execute("document.getElementById('cmd_newNavigator').doCommand()");
    const other = (await waitWindowCount(m, 2)).find((h) => h !== old)!;
    await inWindow(m, other, waitReady);
    expect((await state(m)).windows).toHaveLength(2);
  });
});
