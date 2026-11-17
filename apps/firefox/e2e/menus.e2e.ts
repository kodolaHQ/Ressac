import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady, windowHandles } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import { browserCommands } from "../shared/commands";
import { initialState } from "../core/state/initial-state";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { resolveLocalHosts, siteWindowExpr, startSitesServer, writeSite } from "./sites";

/**
 * The macOS menu bar never leads to a Firefox feature. Headless Firefox has no native menu: an item is fired the way
 * nsMenuUtilsX::DispatchCommandTo does (a trusted command event, whatever its "disabled", as the app menu sends it).
 *
 * After a Firefox update, a failure of « every item is reviewed » lists the new items: decide for each (hide it in
 * chrome/window/firefox-items.ts, or review it here), then the next test fires it.
 *
 * Not covered: the agent app's window (its setup, app-window.ts, mirrors the site window's), and items Firefox shows only
 * in some page states (Affichage › Mode lecture on an article): those are reviewed below by hand.
 */

/** Every item the menu bar shows, and what it does in Ressac. Keyed by id, else by command, else by l10n id. */
const REVIEWED: Record<string, string> = {
  "ressac-commands-menu": "Ressac's « Commandes » menu (chrome/window/commands-menu.ts)",
  ...Object.fromEntries(browserCommands(initialState()).map(({ id }) => [`ressac-command-${id}`, "a Ressac command, as its keys"])),
  "file-menu": "Fichier",
  menu_newNavigatorTab: "off (FIREFOX_COMMANDS), ⌘T is Ressac's",
  menu_newNavigator: "a new Ressac window",
  menu_newPrivateWindow: "off (FIREFOX_COMMANDS)",
  menu_openFile: "file picker, then the file in the current tab",
  menu_close: "off (FIREFOX_COMMANDS), ⌘W is Ressac's",
  menu_closeWindow: "closes the window",
  menu_savePage: "native save dialog",
  "l10n:menu-file-share-url": "macOS share menu",
  menu_print: "print preview",
  goOfflineMenuitem: "work offline",
  menu_FileQuitItem: "quit",
  "edit-menu": "Édition",
  menu_undo: "edit command",
  menu_redo: "edit command",
  menu_cut: "edit command",
  menu_copy: "edit command",
  menu_paste: "edit command",
  menu_delete: "edit command",
  menu_selectAll: "edit command",
  menu_find: "find in page",
  menu_findAgain: "find in page",
  "view-menu": "Affichage",
  viewFullZoomMenu: "Zoom",
  menu_zoomEnlarge: "page zoom",
  menu_zoomReduce: "page zoom",
  menu_zoomReset: "page zoom",
  toggle_zoom: "page zoom",
  pageStyleMenu: "Style de la page",
  menu_pageStyleNoStyle: "page style",
  menu_pageStylePersistentOnly: "page style",
  "repair-text-encoding": "page encoding",
  enterFullScreenItem: "window full screen",
  "history-menu": "Historique (the pages visited, built when it opens)",
  "tools-menu": "Outils",
  menu_openDownloads: "off (FIREFOX_COMMANDS), ⇧⌘J is Ressac's",
  menu_openAddons: "about:addons as a Ressac tab (routeAddonsManager)",
  browserToolsMenu: "Outils du navigateur",
  menu_devToolbox: "web developer tools",
  menu_browserConsole: "browser console window",
  menu_responsiveUI: "responsive design mode",
  menu_eyedropper: "eyedropper",
  menu_pageSource: "view-source as a Ressac tab",
  "ressac-forget-permissions": "Ressac: forgets the site's permissions",
  // Shown on article pages only (never in this test): the page's reader view, kept.
  menu_readerModeItem: "reader view of the page (about:reader in the same tab)",
  windowMenu: "Fenêtre",
  "cmd:cmd_minimizeWindow": "minimize",
  "cmd:zoomWindow": "zoom the window",
  helpMenu: "Aide",
  // Firefox's About window in Ressac's branding (version, update): kept, Thomas likes it. Its menu bar is neutralized.
  aboutName: "Ressac's About window (app menu « À propos de Ressac »)",
  // The app menu (nsMenuBarX takes these out of the bar, whatever their "disabled").
  menu_settings: "Ressac's Réglages",
  menu_preferences: "Ressac's Réglages",
  menu_setAsDefault: "macOS default browser",
  // Firefox's referral page, off by its pref (browser.referrals.enabled, false): a click does nothing, and Firefox hides it
  // once Aide opens. Never hidden by Ressac: changing an app menu item crashed the native menu (0.1.9).
  menu_referralsPage: "nothing (Firefox's referrals pref is off)",
};

/** Not fired, and why. */
const NOT_FIRED: Record<string, string> = {
  // Ressac's own commands run as their keys do (close the window, open one…): fired in e2e/command-bar.e2e.ts.
  ...Object.fromEntries(browserCommands(initialState()).map(({ id }) => [`ressac-command-${id}`, "Ressac's own command"])),
  menu_FileQuitItem: "quits",
  menu_closeWindow: "closes the window under test",
  menu_close: "closes the tab (a popup's: the popup)",
  menu_openFile: "native file picker",
  menu_savePage: "native file picker",
  menu_print: "print dialog",
  goOfflineMenuitem: "the whole app offline",
  enterFullScreenItem: "full screen",
  "cmd:cmd_minimizeWindow": "window manager",
  "cmd:zoomWindow": "window manager",
};

/** Opens what it should, and nothing else Firefox's. */
const EXPECTED: Record<string, { tab?: RegExp; window?: RegExp }> = {
  menu_openAddons: { tab: /^about:addons/ },
  menu_pageSource: { tab: /^view-source:/ },
  menu_browserConsole: { window: /webconsole/ },
  menu_newNavigator: { window: /browser\.xhtml \[main\]/ },
  menu_settings: { tab: /^ressac:\/\/settings$/ },
  menu_preferences: { tab: /^ressac:\/\/settings$/ },
  aboutName: { window: /aboutDialog/ },
};

/** The app menu's items: nsMenuBarX sends them whatever their "disabled"; it skips only the `collapsed` ones. */
const APP_MENU = ["aboutName", "menu_settings", "menu_preferences", "menu_setAsDefault", "menu_referralsPage"];

const WINDOWS = {
  main: `[...Services.wm.getEnumerator("navigator:browser")].find((w) => w.document.documentElement.hasAttribute("ressac-main"))`,
  popup: `[...Services.wm.getEnumerator("navigator:browser")].find((w) => !w.toolbar.visible && !w.document.documentElement.hasAttribute("ressac-site"))`,
  site: siteWindowExpr("menus"),
  hidden: "Services.appShell.hiddenDOMWindow",
  // Firefox's Page Info window (still reachable from code paths Ressac does not use): it has its own menu bar.
  pageInfo: `Services.wm.getMostRecentWindow("Browser:page-info")`,
};
type Kind = keyof typeof WINDOWS;

/** The items a person can reach in window `kind`'s menu bar: shown, and enabled (the app menu's: not collapsed). */
const reachable = (m: Marionette, kind: Kind) =>
  m.execute<{ key: string; label: string }[]>(`
    const win = ${WINDOWS[kind]};
    const doc = win.document;
    const bar = doc.getElementById("main-menubar");
    // Menus build some items when they open (the macOS menu bar fires popupshowing too).
    for (const p of bar.querySelectorAll("menupopup")) p.dispatchEvent(new win.Event("popupshowing", { bubbles: true }));
    const app = ${JSON.stringify(APP_MENU)};
    const shown = (el) => { for (let e = el; e && e !== bar; e = e.parentElement) if (e.hidden || e.collapsed) return false; return true; };
    const out = [];
    for (const el of bar.querySelectorAll("menu, menuitem")) {
      // The pages and windows a menu lists (history, Fenêtre): no id, no command of their own.
      if (!el.id && !el.getAttribute("command") && !el.getAttribute("data-l10n-id")) continue;
      if (app.includes(el.id) ? el.collapsed : !shown(el)) continue;
      const command = el.getAttribute("command");
      if (!app.includes(el.id) && (doc.getElementById(command) ?? el).getAttribute("disabled") === "true") continue;
      out.push({ key: el.id || (command ? "cmd:" + command : "l10n:" + el.getAttribute("data-l10n-id")), label: el.label });
    }
    for (const p of bar.querySelectorAll("menupopup")) p.dispatchEvent(new win.Event("popuphidden", { bubbles: true }));
    return out;`);

/** The windows, Ressac's tabs (the store's) and Firefox's own tabs (no Ressac id). */
async function snapshot(): Promise<{ wins: string[]; tabs: { ressac: string | null; url: string }[] }> {
  const { wins, firefox } = await m.execute<{ wins: string[]; firefox: string[] }>(`
    const wins = [...Services.wm.getEnumerator(null)].map((x) => x.document.documentURI + (x.document.documentElement.hasAttribute("ressac-main") ? " [main]" : ""));
    const firefox = [...Services.wm.getEnumerator("navigator:browser")].flatMap((x) => x.gBrowser?.tabs.filter((t) => !t.getAttribute("ressac-tab-id")).map((t) => t.linkedBrowser.currentURI.spec) ?? []);
    return { wins, firefox };`);
  const ressac = Object.entries((await state(m)).tabs).map(([id, t]) => ({ ressac: id, url: t.url }));
  return { wins, tabs: [...ressac, ...firefox.map((url) => ({ ressac: null, url }))] };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

let server: Awaited<ReturnType<typeof startServer>>;
let sitesServer: Awaited<ReturnType<typeof startSitesServer>>;
let dataDir: string;
let w: LaunchedRessac;
let m: Marionette;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ressac with a page in front, a popup that page opened and a site app's window: one of each kind. */
beforeAll(async () => {
  server = await startServer();
  sitesServer = await startSitesServer();
  sitesServer.define("menus.localhost", "/", "<title>Menus</title>");
  dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
  writeSite(dataDir, "menus", { declaration: { name: "Menus", url: sitesServer.url("menus.localhost", "/"), domains: ["menus.localhost"], login: [] } });
  // A popup opened without a click.
  w = await launchRessac({ dataDir, env: { RESSAC_TEST_LOCAL_ADDRESSES: "1" }, prefs: { "dom.disable_open_during_load": false } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, ["menus.localhost"]);
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: server.url + "/a.html" });
  await waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec`, (u: string) => u.endsWith("/a.html"));
  // The popup, from the page in front as a site would.
  const handle = await m.execute<string>(
    `return ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs").NavigableManager.getIdForBrowser(gBrowser.selectedBrowser);`,
  );
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  await m.execute(`window.open(arguments[0], "menus", "width=500,height=400")`, [server.url + "/b.html"]);
  await m.setContext("chrome");
  await waitFor(m, `return !!${WINDOWS.popup}`, (v: boolean) => v);
  // The site app's window, as « Ouvrir » on the Applications page opens it.
  await m.execute(
    `return (async () => { const store = await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready;
      await store.agent.request("sites.act", { id: "menus", action: "open", window: store.state.windows[0].id }); })();`,
  );
  await waitFor(m, `return ${WINDOWS.site}?.gBrowser.selectedBrowser.currentURI.spec ?? null`, (u: string | null) => !!u?.startsWith("http"), 15_000);
  // Page Info, as the image context menu's « Infos sur l'image » opened it before Ressac hid it.
  await m.execute(`${WINDOWS.main}.BrowserCommands.pageInfo();`);
  await waitFor(m, `return ${WINDOWS.pageInfo}?.document.readyState ?? null`, (v: string | null) => v === "complete", 15_000);
}, 90_000);
afterAll(async () => {
  await w?.close();
  await server?.close();
  await sitesServer?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

/** Fires `key` in window `kind` as macOS does, waits, and returns what appeared; then closes it all. */
async function fire(kind: Kind, key: string): Promise<{ wins: string[]; tabs: Snapshot["tabs"] }> {
  const expected = EXPECTED[key] ?? {};
  const before = await snapshot();
  await m.execute(
    `const win = ${WINDOWS[kind]};
     const doc = win.document;
     const key = arguments[0];
     const el = key.startsWith("cmd:") ? doc.querySelector('#main-menubar menuitem[command="' + key.slice(4) + '"]')
       : key.startsWith("l10n:") ? doc.querySelector('#main-menubar [data-l10n-id="' + key.slice(5) + '"]') : doc.getElementById(key);
     const ev = doc.createEvent("XULCommandEvent");
     ev.initCommandEvent("command", true, true, win, 0, false, false, false, false, 0, null, 0);
     el.dispatchEvent(ev);`,
    [key],
  );
  await sleep(1000);
  const seen = new Set(before.tabs.map((t) => t.ressac ?? t.url));
  const diff = (after: Snapshot) => ({
    wins: after.wins.filter((x) => after.wins.filter((y) => y === x).length > before.wins.filter((y) => y === x).length),
    tabs: after.tabs.filter((t) => !seen.has(t.ressac ?? t.url)),
  });
  let { wins, tabs } = diff(await snapshot());
  // What it should open may take longer under load.
  for (let end = Date.now() + 10_000; Date.now() < end; await sleep(200)) {
    if ((!expected.tab || tabs.some((t) => t.ressac && expected.tab!.test(t.url))) && (!expected.window || wins.some((x) => expected.window!.test(x)))) break;
    ({ wins, tabs } = diff(await snapshot()));
  }
  // Back to the start: Ressac's new tabs closed through the store, every other new window and tab closed.
  for (const t of tabs) if (t.ressac) await dispatch(m, { type: "closeTab", id: t.ressac });
  await m.execute(
    `const keep = new Set(arguments[0]);
     const main = ${WINDOWS.main};
     const kept = new Set([main, ${WINDOWS.popup}, ${WINDOWS.site}, ${WINDOWS.hidden}, ${WINDOWS.pageInfo}]);
     for (const x of [...Services.wm.getEnumerator(null)]) if (!kept.has(x)) x.close();
     for (const x of Services.wm.getEnumerator("navigator:browser"))
       for (const t of [...x.gBrowser.tabs]) if (!t.getAttribute("ressac-tab-id") && !keep.has(t.linkedBrowser.currentURI.spec) && x.gBrowser.tabs.length > 1) x.gBrowser.removeTab(t);`,
    [before.tabs.filter((t) => !t.ressac).map((t) => t.url)],
  );
  await sleep(300);
  return { wins, tabs };
}

describe("the menu bar", () => {
  it("every item is reviewed (a Firefox update that adds one fails here)", async () => {
    const unknown: string[] = [];
    for (const kind of Object.keys(WINDOWS) as Kind[])
      for (const { key, label } of await reachable(m, kind)) if (!(key in REVIEWED)) unknown.push(`${kind}: ${key} (« ${label} »)`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  for (const kind of Object.keys(WINDOWS) as Kind[])
    it(`no item of the ${kind} window leads to Firefox`, { timeout: 180_000 }, async () => {
      const problems: string[] = [];
      for (const { key } of await reachable(m, kind)) {
        if (key in NOT_FIRED || !(key in REVIEWED)) continue;
        const start = (await snapshot()).wins;
        const { wins, tabs } = await fire(kind, key);
        if (process.env.MENUS_DEBUG) (await import("node:fs")).appendFileSync(process.env.MENUS_DEBUG, `${kind} ${key} ${JSON.stringify({ wins, tabs })}\n`);
        const expected = EXPECTED[key] ?? {};
        for (const x of wins) if (!expected.window?.test(x)) problems.push(`${key}: window ${x}`);
        for (const t of tabs) {
          if (!t.ressac) problems.push(`${key}: Firefox tab ${t.url}`);
          else if (/^(about|chrome|view-source):/.test(t.url) && !expected.tab?.test(t.url)) problems.push(`${key}: tab ${t.url}`);
        }
        if (expected.tab && !tabs.some((t) => t.ressac && expected.tab!.test(t.url))) problems.push(`${key}: no ${expected.tab} tab`);
        // A window that came after the wait would hide in the next item's start: the list must be back to this one.
        const late = (await snapshot()).wins.filter((x) => !start.includes(x));
        if (late.length) problems.push(`${key}: late window ${late.join(", ")}`);
      }
      expect(problems).toEqual([]);
    });

  // Last: it closes the main window.
  it("with no main window open, Réglages opens one", async () => {
    for (const h of await windowHandles(m)) {
      await m.command("WebDriver:SwitchToWindow", { handle: h, focus: false });
      if (await m.execute<boolean>(`return document.documentElement.hasAttribute("ressac-site");`)) break;
    }
    await m.execute(`${WINDOWS.main}.close();`);
    await waitFor(m, `return !!${WINDOWS.main}`, (v: boolean) => !v);
    await m.execute(
      `const win = ${WINDOWS.hidden};
       const ev = win.document.createEvent("XULCommandEvent");
       ev.initCommandEvent("command", true, true, win, 0, false, false, false, false, 0, null, 0);
       win.document.getElementById("menu_settings").dispatchEvent(ev);`,
    );
    await waitFor(m, `return !!${WINDOWS.main}?.ressacWindow`, (v: boolean) => v, 15_000);
    await expect.poll(async () => Object.values((await state(m)).tabs).filter((t) => t.url === "ressac://settings").length).toBe(1);
  });
});
