import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { pressKeys, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchWebAiOs();
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"barre-laterale\"]')");
});
afterEach(() => w?.close());

const fenetreId = async () => (await state(m)).fenetres[0]!.id;

describe("the WebAiOs window", () => {
  it("a window reopened after the main one closed (macOS Dock) becomes WebAiOs and follows the store", async () => {
    const old = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    // A module timer outlives the closing window: it opens the new one as the Dock would.
    await m.execute(
      `const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
       const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
       setTimeout(() => BrowserWindowTracker.openWindow(), 500);
       window.close();`,
    );
    const handle = await (async () => {
      for (let i = 0; i < 100; i++) {
        const handles = await m.command<string[]>("WebDriver:GetWindowHandles");
        if (handles.length === 1 && handles[0] !== old) return handles[0]!;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("no new window");
    })();
    await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
    await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"barre-laterale\"]')");

    const before = new Set(Object.keys((await state(m)).onglets));
    const after = await dispatch(m, { type: "ouvrirOnglet", fenetreId: await fenetreId(), url: server.url + "/a.html" });
    const id = Object.keys(after.onglets).find((x) => !before.has(x))!;
    expect(await m.execute("return gBrowser.selectedTab.getAttribute('webaios-tab-id')")).toBe(id);
    await waitUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="onglet-${id}"]`]);
  });

  it("Firefox's menu commands neither add tabs nor open or close windows", async () => {
    const before = new Set(Object.keys((await state(m)).onglets));
    const after = await dispatch(m, { type: "ouvrirOnglet", fenetreId: await fenetreId(), url: server.url + "/a.html" });
    const id = Object.keys(after.onglets).find((x) => !before.has(x))!;
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('webaios-tab-id')", (v) => v === id);
    // doCommand ignores "disabled": that is the path a stray caller takes; no WebAiOs tab may come of it.
    for (const cmd of ["cmd_newNavigatorTab", "menu_newNavigatorTab"]) await m.execute("document.getElementById(arguments[0]).doCommand()", [cmd]);
    await new Promise((r) => setTimeout(r, 500));
    expect(Object.keys((await state(m)).onglets).length).toBe(Object.keys(after.onglets).length);
    expect(await m.execute("return gBrowser.selectedTab.getAttribute('webaios-tab-id')")).toBe(id);
    // macOS's native menu item is enabled from its command's "disabled" (nsMenuItemX::SetEnabled); headless has no native menu.
    const items = ["menu_newNavigatorTab", "menu_newNavigator", "menu_newPrivateWindow", "menu_close", "menu_closeWindow", "menu_preferences"];
    const enabled = `return arguments[0].filter((id) => {
      const item = document.getElementById(id);
      return !(document.getElementById(item.getAttribute("command")) ?? item).hasAttribute("disabled");
    })`;
    expect(await m.execute(enabled, [items])).toEqual([]);
    // ⇧⌘W, a real key press: the window stays.
    await pressKeys(m, "Meta+Shift+w");
    await new Promise((r) => setTimeout(r, 500));
    expect(await m.execute("return !window.closed && !!window.webaiosWindow")).toBe(true);
  });
});
