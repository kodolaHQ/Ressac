import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { button, cleanupXpis, writeXpi } from "./addons";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { waitUi } from "./ui";

// Prompts of sites and add-ons anchor on #webaios-anchor (chrome/window/anchor.ts), not at the window's (0, 0).

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => (server = await startServer()));
afterAll(async () => {
  await server?.close();
  await cleanupXpis();
});

/** Chrome-context helpers: `until(f)` polls f up to 5 s; `panelState()` is where PopupNotifications' panel is. */
const HELPERS = `
  const until = async (f) => { for (let i = 0; i < 50 && !f(); i++) await new Promise((r) => setTimeout(r, 100)); return f(); };
  const panelState = () => {
    const panel = PopupNotifications.panel;
    const r = panel.getOuterScreenRect();
    const box = document.getElementById("webaios-anchor")?.getBoundingClientRect();
    return {
      state: panel.state,
      anchor: panel.anchorNode?.id ?? null,
      // The panel's top, relative to the anchor's top: positive below it, never the window's (0, 0).
      belowAnchor: box ? r.top - (window.mozInnerScreenY + box.top) : null,
    };
  };`;

/** Removes every prompt shown and waits until the panel is closed. */
const CLEAR = `return (async () => {
  ${HELPERS}
  for (const n of [...PopupNotifications._currentNotifications]) PopupNotifications.remove(n);
  await until(() => PopupNotifications.panel.state === "closed");
})();`;

describe("prompts anchor on the sidebar", () => {
  let w: LaunchedWebAiOs;
  let m: Marionette;

  /** Opens `path` in a WebAiOs tab, waits until it is loaded; returns the tab id. */
  async function open(path: string): Promise<string> {
    const before = new Set(Object.keys((await state(m)).onglets));
    const url = server.url + path;
    const s = await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url });
    await waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(url)} && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`, (v) => v === true);
    return Object.keys(s.onglets).find((id) => !before.has(id))!;
  }

  beforeAll(async () => {
    w = await launchWebAiOs();
    m = w.marionette;
    await m.setContext("chrome");
    await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
    await waitUi(m, `return !!doc.querySelector('[data-testid="barre-adresse"]')`);
  });
  afterAll(() => w?.close());

  it("a site's geolocation request opens on #webaios-anchor, over the address bar", async () => {
    await open("/geo");
    const r = await m.execute<any>(`return (async () => {
      ${HELPERS}
      const b = gBrowser.selectedBrowser;
      await until(() => PopupNotifications.getNotification("geolocation", b) && PopupNotifications.panel.state === "open");
      const frame = document.getElementById("webaios-sidebar");
      const f = frame.getBoundingClientRect();
      const bar = frame.contentDocument.querySelector('[data-testid="barre-adresse"]').getBoundingClientRect();
      const box = document.getElementById("webaios-anchor").getBoundingClientRect();
      return {
        notification: !!PopupNotifications.getNotification("geolocation", b),
        ...panelState(),
        box: [box.x, box.y, box.width, box.height],
        bar: [f.x + bar.x, f.y + bar.y, bar.width, bar.height],
      };
    })();`);
    await m.execute(CLEAR);
    expect(r).toMatchObject({ notification: true, state: "open", anchor: "webaios-anchor" });
    r.box.forEach((v: number, i: number) => expect(Math.abs(v - r.bar[i])).toBeLessThanOrEqual(1));
  });

  it("installing an add-on from a page opens its prompt on #webaios-anchor", async () => {
    await open("/texte.html");
    // Unsigned, normal mode: the first (and only) prompt is addon-install-failed (spike S2).
    const r = await m.execute<any>(
      `return (async () => {
        ${HELPERS}
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
        const b = gBrowser.selectedBrowser;
        const install = await AddonManager.getInstallForFile(new FileUtils.File(arguments[0]));
        AddonManager.installAddonFromWebpage("application/x-xpinstall", b, b.contentPrincipal, install);
        await until(() => PopupNotifications.getNotification("addon-install-failed", b) && PopupNotifications.panel.state === "open");
        return { notification: !!PopupNotifications.getNotification("addon-install-failed", b), ...panelState() };
      })();`,
      [await writeXpi(button())],
    );
    await m.execute(CLEAR);
    expect(r).toMatchObject({ notification: true, state: "open", anchor: "webaios-anchor" });
    expect(r.belowAnchor).toBeGreaterThan(0);
  });

  /** Chrome context: shows the permissions prompt on the selected browser; window.webaiosAnswer tracks its promise. */
  const SHOW_PERMISSIONS = `
    const { ExtensionsUI } = ChromeUtils.importESModule("resource:///modules/ExtensionsUI.sys.mjs");
    const { ExtensionData } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
    const strings = ExtensionData.formatPermissionStrings({ addon: { name: "Demande" }, permissions: { permissions: ["tabs"], origins: ["<all_urls>"] } }, { fullDomainsList: true });
    strings.addonName = "Demande";
    const answer = { done: false, value: undefined };
    window.webaiosAnswer = answer;
    ExtensionsUI.showPermissionsPrompt(gBrowser.selectedBrowser, strings, null).then((v) => Object.assign(answer, { done: true, value: v }));
    await until(() => PopupNotifications.getNotification("addon-webext-permissions", gBrowser.selectedBrowser) && PopupNotifications.panel.state === "open");`;

  it("the permission prompt opens on #webaios-anchor", async () => {
    await open("/texte.html");
    const r = await m.execute<any>(`return (async () => {
      ${HELPERS}
      ${SHOW_PERMISSIONS}
      return { notification: !!PopupNotifications.getNotification("addon-webext-permissions", gBrowser.selectedBrowser), ...panelState() };
    })();`);
    await m.execute(CLEAR);
    expect(r).toMatchObject({ notification: true, state: "open", anchor: "webaios-anchor" });
    expect(r.belowAnchor).toBeGreaterThan(0);
    // Removed without an answer: a refusal, as a real prompt closed.
    expect(await m.execute(`return (async () => { ${HELPERS} await until(() => window.webaiosAnswer.done); return window.webaiosAnswer; })();`)).toEqual({ done: true, value: false });
  });

  it("an add-on prompt survives a tab switch", async () => {
    const a = await open("/texte.html");
    const b = await open("/a.html");
    const selected = (id: string) => `gBrowser.selectedTab.getAttribute("webaios-tab-id") === ${JSON.stringify(id)}`;
    await dispatch(m, { type: "activerOnglet", id: a });
    await waitFor(m, `return ${selected(a)}`, (v) => v === true);
    const browserA = `gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === ${JSON.stringify(a)}).linkedBrowser`;
    await m.execute(`return (async () => { ${HELPERS} ${SHOW_PERMISSIONS} })();`);
    await dispatch(m, { type: "activerOnglet", id: b });
    await waitFor(m, `return PopupNotifications.panel.state === "closed" && ${selected(b)}`, (v) => v === true);
    await dispatch(m, { type: "activerOnglet", id: a });
    const r = await m.execute<any>(`return (async () => {
      ${HELPERS}
      await until(() => PopupNotifications.panel.state === "open");
      return { notification: !!PopupNotifications.getNotification("addon-webext-permissions", ${browserA}), done: window.webaiosAnswer.done, ...panelState() };
    })();`);
    await m.execute(CLEAR);
    expect(r).toMatchObject({ notification: true, done: false, state: "open", anchor: "webaios-anchor" });
  });

  it("the app-menu doorhanger anchors on #webaios-anchor", async () => {
    // The real "added" doorhanger opens only in an active window, never headless: a manual check.
    const r = await m.execute<any>(`return {
      menu: PanelUI._getPanelAnchor(PanelUI.menuButton) === document.getElementById("webaios-anchor"),
      other: PanelUI._getPanelAnchor(document.documentElement) === document.documentElement,
    };`);
    expect(r).toEqual({ menu: true, other: true });
  });
});
