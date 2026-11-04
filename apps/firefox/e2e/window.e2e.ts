import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatch, inWindow, state, waitFor, waitWindowCount, windowHandles } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inUi, pressKeys, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
/** The current window is WebAiOs: its controller, its parking tab and its sidebar are up. */
async function waitReady(): Promise<void> {
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"barre-laterale\"]')");
}
beforeEach(async () => {
  w = await launchWebAiOs();
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady();
});
afterEach(() => w?.close());

const fenetreId = async () => (await state(m)).fenetres[0]!.id;
const handle = async () => (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A key that closes the current window: its key-ups have no window left to go to. */
const pressClosing = (combo: string) =>
  pressKeys(m, combo).catch((e) => {
    if (!/no such window/.test(String(e))) throw e;
  });
async function openTab(fenetre: string, path: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).onglets));
  const after = await dispatch(m, { type: "ouvrirOnglet", fenetreId: fenetre, url: server.url + path });
  return Object.keys(after.onglets).find((x) => !before.has(x))!;
}
/** ⌘N from the current window: waits for the second WebAiOs window to be up; returns its handle. */
async function newWindow(): Promise<string> {
  const old = await handle();
  await pressKeys(m, "Meta+n");
  const other = (await waitWindowCount(m, 2)).find((h) => h !== old)!;
  await inWindow(m, other, waitReady);
  return other;
}
/**
 * Closes the only window, then, from a module timer (Marionette has no window to run in meanwhile): counts the browser
 * windows, dispatches `choisirMoteur`, counts again 300 ms later into the pref `webaios.test.closed`, and runs `reopen`.
 */
async function closeLastWindow(reopen: string): Promise<{ closed: number; afterEngine: number }> {
  const old = await handle();
  await m.execute(
    `return (async () => {
      const store = await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready;
      const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
      const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
      const count = () => [...Services.wm.getEnumerator("navigator:browser")].length;
      window.close();
      setTimeout(() => {
        const closed = count();
        store.dispatch({ type: "choisirMoteur", moteur: "qwant" });
        setTimeout(() => {
          Services.prefs.setStringPref("webaios.test.closed", JSON.stringify({ closed, afterEngine: count() }));
          ${reopen};
        }, 300);
      }, 500);
    })();`,
  );
  const reopened = (await waitWindowCount(m, 1)).find((h) => h !== old);
  if (!reopened) throw new Error("the window was not reopened");
  await m.command("WebDriver:SwitchToWindow", { handle: reopened, focus: false });
  await waitReady();
  return JSON.parse(await m.execute<string>(`return Services.prefs.getStringPref("webaios.test.closed")`));
}

describe("the WebAiOs window", () => {
  it("⌘N opens a second WebAiOs window on the active space, with its own sidebar", async () => {
    const first = await fenetreId();
    const s = await dispatch(m, { type: "creerEspace", nom: "Travail", icone: "💼", prive: false, profil: "defaut", fenetreId: first });
    const espace = s.espaces.at(-1)!.id;
    expect(s.fenetres[0]!.espaceActif).toBe(espace);
    const other = await newWindow();
    const after = await state(m);
    expect(after.fenetres).toHaveLength(2);
    const id = await inWindow(m, other, async () => {
      expect(await m.execute("return document.documentElement.hasAttribute('webaios-main')")).toBe(true);
      return m.execute<string>("return window.webaiosWindow.fenetreId");
    });
    expect(id).not.toBe(first);
    expect(after.fenetres.find((f) => f.id === id)!.espaceActif).toBe(espace);
    // Its sidebar acts on its own window.
    const tab = await openTab(id, "/a.html");
    await inWindow(m, other, () => waitUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="onglet-${tab}"]`]));
    expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="onglet-${tab}"]`])).toBe(false);
  });

  it("⇧⌘W closes one window among two: it leaves the state, its tabs go to the other's fermesRecemment", async () => {
    const first = await fenetreId();
    const other = await newWindow();
    const id = await inWindow(m, other, () => m.execute<string>("return window.webaiosWindow.fenetreId"));
    const tab = await openTab(id, "/a.html");
    await inWindow(m, other, async () => {
      await waitFor(m, "return gBrowser.selectedTab.getAttribute('webaios-tab-id')", (v) => v === tab);
      await pressClosing("Meta+Shift+w");
    });
    await waitWindowCount(m, 1);
    const after = await state(m);
    expect(after.fenetres[0]!.id).toBe(first);
    expect(after.onglets[tab]).toBeUndefined();
    expect(after.fenetres[0]!.fermesRecemment[0]?.url).toBe(server.url + "/a.html");
  });

  it("macOS: closing the last window keeps the app and its tabs in the state; no XUL tab is left; choisirMoteur does not reopen it; the Dock reopens it with its tabs listed", async () => {
    const id = await fenetreId();
    const tab = await openTab(id, "/a.html");
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('webaios-tab-id')", (v) => v === tab);
    // A module timer outlives the closing window: it opens the new one as the Dock would.
    const counts = await closeLastWindow("BrowserWindowTracker.openWindow()");
    // No window, so no XUL tab: the page closed with it.
    expect(counts).toEqual({ closed: 0, afterEngine: 0 });
    const s = await state(m);
    expect(s.reglages.moteur).toBe("qwant");
    expect(s.fenetres.map((f) => f.id)).toEqual([id]);
    expect(await m.execute("return window.webaiosWindow.fenetreId")).toBe(id);
    await waitUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="onglet-${tab}"]`]);
    // It still follows the store.
    const next = await openTab(id, "/b.html");
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('webaios-tab-id')", (v) => v === next);
  });

  it("with no window open, OpenBrowserWindow (the hidden window's ⌘N) brings the closed window back, and no second one", async () => {
    const id = await fenetreId();
    await closeLastWindow("Services.appShell.hiddenDOMWindow.OpenBrowserWindow()");
    await sleep(300);
    expect(await windowHandles(m)).toHaveLength(1);
    expect(await m.execute("return window.webaiosWindow.fenetreId")).toBe(id);
    expect((await state(m)).fenetres.map((f) => f.id)).toEqual([id]);
  });

  it("⌘W on the empty page of a window without tabs closes it; the app stays", async () => {
    await pressClosing("Meta+w");
    await waitWindowCount(m, 0);
    await sleep(300);
    // Firefox still runs and answers.
    expect(await windowHandles(m)).toEqual([]);
    expect(() => process.kill(w.pid, 0)).not.toThrow();
  });

  it("a private window is never WebAiOs, with a WebAiOs window open or after the last one closed", async () => {
    const id = await fenetreId();
    const old = await handle();
    const notWebAiOs = "return [document.documentElement.hasAttribute('webaios-main'), !!window.webaiosWindow]";
    await m.execute("OpenBrowserWindow({ private: true })");
    const priv = (await waitWindowCount(m, 2)).find((h) => h !== old)!;
    await inWindow(m, priv, async () => {
      await m.execute("return delayedStartupPromise.then(() => new Promise((r) => setTimeout(r, 500)))");
      expect(await m.execute(notWebAiOs)).toEqual([false, false]);
      await m.execute("window.close()");
    });
    await waitWindowCount(m, 1);
    expect((await state(m)).fenetres.map((f) => f.id)).toEqual([id]);
    // The last window closed: the hidden window's ⇧⌘P opens a private window, which must not take the kept one.
    await m.execute(
      `return (async () => {
        const store = await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready;
        const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
        const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
        window.close();
        setTimeout(() => {
          const p = Services.appShell.hiddenDOMWindow.OpenBrowserWindow({ private: true });
          // Its delayedStartupPromise does not exist yet: give it time to start (and to claim, if it would).
          setTimeout(() => {
            Services.prefs.setStringPref("webaios.test.private", JSON.stringify({
              adopted: p.document.documentElement.hasAttribute("webaios-main"),
              fenetres: store.state.fenetres.map((f) => f.id),
            }));
            p.close();
            BrowserWindowTracker.openWindow();
          }, 2000);
        }, 500);
      })();`,
    );
    // The private window shows alone for a while: wait for the WebAiOs one.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const handles = await windowHandles(m);
      if (handles.length === 1 && handles[0] !== old && handles[0] !== priv) {
        await m.command("WebDriver:SwitchToWindow", { handle: handles[0], focus: false });
        if (await m.execute("return !!window.webaiosWindow").catch(() => false)) break;
      }
      if (Date.now() > deadline) throw new Error("the WebAiOs window did not come back");
      await sleep(100);
    }
    expect(JSON.parse(await m.execute<string>(`return Services.prefs.getStringPref("webaios.test.private")`))).toEqual({ adopted: false, fenetres: [id] });
    // The kept window was not consumed: the next window takes it back.
    expect(await m.execute("return window.webaiosWindow.fenetreId")).toBe(id);
    expect((await state(m)).fenetres.map((f) => f.id)).toEqual([id]);
  });

  it("Firefox's menu commands add no tabs; New Window and Close Window lead to WebAiOs windows", async () => {
    const tab = await openTab(await fenetreId(), "/a.html");
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('webaios-tab-id')", (v) => v === tab);
    // doCommand ignores "disabled": that is the path a stray caller takes; no WebAiOs tab may come of it.
    for (const cmd of ["cmd_newNavigatorTab", "menu_newNavigatorTab"]) await m.execute("document.getElementById(arguments[0]).doCommand()", [cmd]);
    await sleep(500);
    expect(Object.keys((await state(m)).onglets)).toEqual([tab]);
    expect(await m.execute("return gBrowser.selectedTab.getAttribute('webaios-tab-id')")).toBe(tab);
    // macOS's native menu item is enabled from its command's "disabled" (nsMenuItemX::SetEnabled); headless has no native menu.
    const items = ["menu_newNavigatorTab", "menu_newNavigator", "menu_newPrivateWindow", "menu_close", "menu_closeWindow", "menu_preferences"];
    const enabled = `return arguments[0].filter((id) => {
      const item = document.getElementById(id);
      return !(document.getElementById(item.getAttribute("command")) ?? item).hasAttribute("disabled");
    })`;
    expect(await m.execute(enabled, [items])).toEqual(["menu_newNavigator", "menu_closeWindow"]);
    const old = await handle();
    await m.execute("document.getElementById('cmd_newNavigator').doCommand()");
    const other = (await waitWindowCount(m, 2)).find((h) => h !== old)!;
    await inWindow(m, other, waitReady);
    expect((await state(m)).fenetres).toHaveLength(2);
  });
});
