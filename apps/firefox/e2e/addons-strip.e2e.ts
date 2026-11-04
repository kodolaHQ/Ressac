import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { button, cleanupXpis, installAddon, uninstallAddon } from "./addons";
import { dispatch, inWindow, newWindow, state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";

// The window side of the sidebar's add-on strip (chrome/window/addons.ts), on window.webaiosWindow.addons.

const ID = "button@webaios.test";
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
  // window.changes counts onChange calls.
  await m.execute("window.changes = 0; window.webaiosWindow.addons.onChange(() => window.changes++)");
});
afterEach(() => w?.close());

const A = "window.webaiosWindow.addons";
const buttons = () => m.execute<any[]>(`return ${A}.buttons()`);
const changes = () => m.execute<number>("return window.changes");
const fenetreId = async () => (await state(m)).fenetres[0]!.id;
/** Opens `path` in a WebAiOs tab and waits until it is displayed and loaded. */
async function open(path: string): Promise<void> {
  const url = server.url + path;
  await dispatch(m, { type: "ouvrirOnglet", fenetreId: await fenetreId(), url });
  await waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(url)} && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`, (v) => v === true);
}
/** Chrome context: polls f up to 5 s. */
const UNTIL = "const until = async (f) => { for (let i = 0; i < 50 && !f(); i++) await new Promise((r) => setTimeout(r, 100)); return f(); };";
/** Clicks the button at `rect`, waits for the popup to be ready; returns its panel, the anchor and their screen rects. */
const clickAndWait = (rect: { x: number; y: number; width: number; height: number }) =>
  m.execute<any>(
    `return (async () => {
      ${UNTIL}
      ${A}.click(arguments[0], arguments[1]);
      const popup = () => document.querySelector("browser.webextension-popup-browser");
      await until(() => popup()?.contentTitle === "Popup de test prête" && popup().closest("panel")?.state === "open");
      const panel = popup()?.closest("panel");
      const anchor = document.getElementById("webaios-action-anchor").getBoundingClientRect();
      const frame = document.getElementById("webaios-sidebar");
      const f = frame.getBoundingClientRect();
      return {
        title: popup()?.contentTitle,
        anchorId: panel?.anchorNode?.id ?? null,
        anchor: [anchor.x, anchor.y],
        expected: [f.x + frame.clientLeft + arguments[1].x, f.y + frame.clientTop + arguments[1].y],
        panelLeft: panel?.getOuterScreenRect().left,
        anchorScreenLeft: window.mozInnerScreenX + anchor.x,
      };
    })();`,
    [ID, rect],
  );
const CLOSE_POPUP = `return (async () => {
  const panel = document.querySelector("browser.webextension-popup-browser")?.closest("panel");
  if (panel?.state !== "open") return;
  const hidden = new Promise((r) => panel.addEventListener("popuphidden", r, { once: true }));
  panel.hidePopup();
  await hidden;
})();`;

describe("add-on strip, window side", () => {
  it("lists an add-on's button with its title, icon and badge", async () => {
    await installAddon(m, button({ badge: "3" }));
    const [b] = await waitFor(m, `return ${A}.buttons()`, (l: any[]) => l[0]?.badge === "3");
    expect(b).toMatchObject({ id: ID, title: "Bouton de test", badge: "3", pinned: false });
    expect(b.icon).toMatch(/^moz-extension:\/\//);
    expect(b.badgeColor).toMatch(/^rgba\(/);
    // A badge change reaches the window through the action's updateButton.
    const before = await changes();
    await m.execute("gUnifiedExtensions.browserActionFor(WebExtensionPolicy.getByID(arguments[0])).action.setPropertyFromDetails({}, 'badgeText', '4')", [ID]);
    await waitFor(m, "return window.changes", (n: number) => n > before);
    expect((await buttons())[0].badge).toBe("4");
  });

  it("a button is disabled without a web page", async () => {
    await installAddon(m, button());
    await waitFor(m, `return ${A}.buttons()`, (l: any[]) => l.length === 1);
    expect((await buttons())[0].enabled).toBe(false);
    let seen = await changes();
    await open("/texte.html");
    await waitFor(m, `return ${A}.buttons()[0].enabled`, (v) => v === true);
    expect(await changes()).toBeGreaterThan(seen);
    seen = await changes();
    await dispatch(m, { type: "ouvrirApplications", fenetreId: await fenetreId() });
    await waitFor(m, "return gBrowser.selectedTab.hasAttribute('webaios-parking')", (v) => v === true);
    expect((await buttons())[0].enabled).toBe(false);
    expect(await changes()).toBeGreaterThan(seen);
  });

  it("click opens the popup on the action anchor, from the button's left edge", async () => {
    await installAddon(m, button());
    await open("/texte.html");
    await waitFor(m, `return ${A}.buttons()[0]?.enabled`, (v) => v === true);
    const r = await clickAndWait({ x: 10, y: 80, width: 24, height: 24 });
    expect(r).toMatchObject({ title: "Popup de test prête", anchorId: "webaios-action-anchor" });
    r.anchor.forEach((v: number, i: number) => expect(Math.abs(v - r.expected[i])).toBeLessThanOrEqual(1));
    expect(Math.abs(r.panelLeft - r.anchorScreenLeft)).toBeLessThanOrEqual(2);
    await m.execute(CLOSE_POPUP);
    // Away from the window's edge, where Firefox would open it leftward: realigned as soon as it is shown.
    const far = await clickAndWait({ x: 200, y: 80, width: 24, height: 24 });
    expect(far.title).toBe("Popup de test prête");
    expect(Math.abs(far.panelLeft - far.anchorScreenLeft)).toBeLessThanOrEqual(2);
    await m.execute(CLOSE_POPUP);
  });

  it("a disabled click opens nothing", async () => {
    await installAddon(m, button());
    await waitFor(m, `return ${A}.buttons()`, (l: any[]) => l.length === 1);
    await m.execute(`${A}.click(arguments[0], { x: 10, y: 80, width: 24, height: 24 })`, [ID]);
    await new Promise((r) => setTimeout(r, 1000));
    expect(await m.execute("return !!document.querySelector('browser.webextension-popup-browser')")).toBe(false);
  });

  it("pin is kept in the pref and seen by every window", async () => {
    await installAddon(m, button());
    await waitFor(m, `return ${A}.buttons()`, (l: any[]) => l.length === 1);
    await m.execute(`${A}.pin(arguments[0], true)`, [ID]);
    expect(await m.execute("return Services.prefs.getStringPref('webaios.extensions.pinned')")).toBe(JSON.stringify([ID]));
    expect((await buttons())[0].pinned).toBe(true);
    const second = await newWindow(m);
    expect(await inWindow(m, second, () => buttons().then((l) => l[0]?.pinned))).toBe(true);
  });

  it("an uninstalled pinned add-on leaves the strip", async () => {
    // Errors reported by the window's script (chrome://browser/content/webaios/…) while the add-on goes.
    await m.execute(`window.webaiosErrors = [];
      Services.console.registerListener({ observe: (e) => e instanceof Ci.nsIScriptError && !(e.flags & Ci.nsIScriptError.warningFlag) && e.sourceName.includes("webaios") && window.webaiosErrors.push(e.errorMessage) });`);
    await installAddon(m, button());
    await waitFor(m, `return ${A}.buttons()`, (l: any[]) => l.length === 1);
    await m.execute(`${A}.pin(arguments[0], true)`, [ID]);
    let seen = await changes();
    await m.execute(`const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      return AddonManager.getAddonByID(arguments[0]).then((a) => a.disable()).then(() => 0);`, [ID]);
    await waitFor(m, `return ${A}.buttons()`, (l: any[]) => l.length === 0);
    expect(await changes()).toBeGreaterThan(seen);
    await m.execute(`const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      return AddonManager.getAddonByID(arguments[0]).then((a) => a.enable()).then(() => 0);`, [ID]);
    await waitFor(m, `return ${A}.buttons()`, (l: any[]) => l[0]?.pinned === true);
    seen = await changes();
    await uninstallAddon(m, ID);
    await waitFor(m, `return ${A}.buttons()`, (l: any[]) => l.length === 0);
    expect(await changes()).toBeGreaterThan(seen);
    expect(await m.execute("return Services.prefs.getStringPref('webaios.extensions.pinned')")).toBe(JSON.stringify([ID]));
    expect(await m.execute("return window.webaiosErrors")).toEqual([]);
  });

  it("a click does not move an open prompt", async () => {
    await installAddon(m, button());
    await open("/texte.html");
    await waitFor(m, `return ${A}.buttons()[0]?.enabled`, (v) => v === true);
    await m.execute(`return (async () => {
      ${UNTIL}
      const { ExtensionsUI } = ChromeUtils.importESModule("resource:///modules/ExtensionsUI.sys.mjs");
      const { ExtensionData } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
      const strings = ExtensionData.formatPermissionStrings({ addon: { name: "Demande" }, permissions: { permissions: ["tabs"], origins: ["<all_urls>"] } }, { fullDomainsList: true });
      strings.addonName = "Demande";
      ExtensionsUI.showPermissionsPrompt(gBrowser.selectedBrowser, strings, null);
      await until(() => PopupNotifications.panel.state === "open");
    })();`);
    const r = await clickAndWait({ x: 10, y: 80, width: 24, height: 24 });
    expect(r.title).toBe("Popup de test prête");
    expect(await m.execute("return PopupNotifications.panel.anchorNode?.id")).toBe("webaios-anchor");
    await m.execute(CLOSE_POPUP);
  });

  it("a pending update is listed and reviewed", async () => {
    const entry = { addon: { id: ID, name: "Bouton de test" } };
    await m.execute(
      `const { ExtensionsUI } = ChromeUtils.importESModule("resource:///modules/ExtensionsUI.sys.mjs");
       window.reviewed = [];
       ExtensionsUI.showUpdate = (browser, info) => window.reviewed.push({ gBrowser: browser === gBrowser, same: info === window.entry });
       window.entry = arguments[0];
       ExtensionsUI.updates.add(window.entry);
       ExtensionsUI.emit("change");`,
      [entry],
    );
    await waitFor(m, "return window.changes", (n: number) => n > 0);
    expect(await m.execute(`return ${A}.updates()`)).toEqual([{ id: ID, name: "Bouton de test" }]);
    await m.execute(`${A}.reviewUpdate(arguments[0])`, [ID]);
    expect(await m.execute("return window.reviewed")).toEqual([{ gBrowser: true, same: true }]);
  });
});
