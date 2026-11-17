import type { WindowController } from "./controller";
import { FIREFOX_COMMANDS } from "./keys";

// Loaded when needed: e2e tests import this file's list in Node.
const tracker = () => ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs").BrowserWindowTracker;

/**
 * Firefox menu items that compete with Ressac's own features (profiles, containers outside a space, private windows,
 * bookmarks, session restore, import, Firefox View, toolbar customizing, Mozilla's Help menu) or lead to Firefox's own
 * pages and windows. Hidden rather than disabled: the macOS menu bar honours `hidden`, and Firefox builds some of them
 * without a command. e2e/menus.e2e.ts fails on any item a Firefox update adds to the menu bar.
 */
export const FIREFOX_HIDDEN_ITEMS = [
  "profiles-menu",
  "menu_newUserContext",
  "context-openlinkinusercontext-menu",
  "context-openlinkprivate",
  "context-searchselect-private",
  "bookmarksMenu",
  "context-bookmarkpage",
  "context-bookmarklink",
  "context-bookmarkframe",
  "historyRestoreLastSession",
  "historyUndoWindowMenu",
  "menu_importFromAnotherBrowser",
  "menu_openFirefoxView",
  "menu_customizeToolbars",
  // Help: everything but « À propos » (macOS moves it into the app menu).
  "menu_openHelp",
  "help_reportBrokenSite",
  "feedbackPage",
  "helpSafeMode",
  "troubleShooting",
  "menu_HelpPopup_reportPhishingtoolmenu",
  "menu_HelpPopup_reportPhishingErrortoolmenu",
  "helpSwitchDevice",
  "aboutSeparator",
  // Built in a non-official build only, in English: restarts Firefox with its startup cache dropped.
  "menu_FileRestartItem",
  // Firefox's toolbars (its bookmarks bar) and sidebar: Ressac hides both.
  "viewToolbarsMenu",
  "viewSidebarMenuMenu",
  // History: searches in Firefox's hidden address bar, Firefox's « clear recent history » dialog and its own closed tabs.
  "menu_searchHistory",
  "menu_searchTabs",
  "sanitizeItem",
  "historyUndoMenu",
  "menu_showAllHistory",
  // Tools: about:pdf, about:processes, about:debugging, Mozilla's add-ons collection, the browser's own toolbox.
  "menu_editPDF",
  "menu_taskManager",
  "menu_devtools_remotedebugging",
  "extensionsForDevelopers",
  "menu_browserToolbox",
  // Firefox's Page Info window: its Permissions tab goes around the space's site permissions.
  "menu_pageInfo",
  // The image context menu's Firefox windows (Page Info, set as desktop background): each brings Firefox's menu bar.
  "context-viewimageinfo",
  "context-setDesktopBackground",
  // The hidden window's (no window open): its Dock menu's private window, and « Ouvrir l'emplacement » in a new window.
  "macDockMenuNewPrivateWindow",
  "menu_openLocation",
];

/**
 * Items macOS moves into the app menu (nsMenuBarX::AquifyMenuBar). Never hidden nor collapsed here: changing one rebuilds
 * the native app menu under AppKit, which then messages a freed menu (0.1.9 crashed on « À propos de Ressac »).
 */
export const APP_MENU_ITEMS = ["aboutName", "menu_preferences", "menu_settings", "menu_setAsDefault", "menu_referralsPage", "menu_mac_services", "menu_mac_hide_app", "menu_mac_hide_others", "menu_mac_show_all", "menu_FileQuitItem"];

/**
 * Hides FIREFOX_HIDDEN_ITEMS now and on every popupshowing: Firefox re-shows some (nsContextMenu, profiles) while its menu
 * opens, from a listener on the popup set; ours, on the window in the bubble phase, runs after it.
 */
export function hideFirefoxItems(win: Window): () => void {
  const hide = () => {
    for (const id of FIREFOX_HIDDEN_ITEMS) {
      const el = win.document.getElementById(id);
      if (!el) continue;
      el.hidden = true;
      // The app menu's items are always `hidden` (nsMenuBarX::AquifyMenuBar): it skips the `collapsed` ones.
      el.setAttribute("collapsed", "true");
    }
  };
  hide();
  win.addEventListener("popupshowing", hide);
  return () => win.removeEventListener("popupshowing", hide);
}

/**
 * Items that open Réglages. macOS sends the app menu's items to the window in front whatever their "disabled"
 * (nsMenuBarX menuItemHit), so browser-menubar.js would open about:preferences or Firefox's about dialog (and its
 * Firefox update) from any window Ressac does not route.
 */
const SETTINGS_ITEMS = ["menu_preferences", "menu_settings", "aboutName"];

type RessacWindow = Window & { ressacWindow?: WindowController };

/** This window if it is a main window, else the last one used, else a new one (the app menu works with no window). */
async function mainWindow(win: RessacWindow): Promise<RessacWindow | undefined> {
  if (win.ressacWindow) return win;
  const used: RessacWindow | undefined = tracker().orderedWindows.find((w: RessacWindow) => w.ressacWindow);
  if (used) return used;
  const opened: RessacWindow = tracker().openWindow();
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => win.setTimeout(r, 100)))
    if (opened.ressacWindow) return opened;
}

/**
 * Routes SETTINGS_ITEMS to Ressac's Réglages in every window, the hidden one included: a capture listener on the menu
 * bar runs before the item's own listeners and browser-menubar.js's.
 */
export function routeSettingsItems(win: RessacWindow): void {
  win.document.getElementById("main-menubar")?.addEventListener(
    "command",
    (e) => {
      if (!SETTINGS_ITEMS.includes((e.target as Element).id)) return;
      e.stopPropagation();
      void mainWindow(win).then((main) => {
        if (!main) return;
        // As ⌘,: nothing during the welcome screen.
        main.ressacWindow!.shortcut({ type: "settings" });
        main.focus();
      });
    },
    true,
  );
}

/**
 * about:addons opens as a Ressac tab of a main window (routeAddonsManager replaces this in main windows): from a site or
 * app window, a popup or the hidden one, Firefox would open it as one of its own tabs.
 */
export function routeAddonsToMain(win: RessacWindow): void {
  const ui = (win as any).BrowserAddonUI;
  if (!ui) return;
  const own = ui.openAddonsMgr.bind(ui);
  ui.openAddonsMgr = async (view?: string) => {
    const main = await mainWindow(win);
    if (!main || main === win) return own(view);
    main.focus();
    return (main as any).BrowserAddonUI.openAddonsMgr(view);
  };
}

/**
 * A window that carries Firefox's whole menu bar but is not Ressac's: the hidden one (the menu bar macOS shows with no
 * window open), Page Info, the Library, set as desktop background, Firefox's About. Same items hidden and routed; Firefox's
 * commands off as in a site window, but ⌘W (closes it) and ⌘T (with no window open, opens one).
 */
export function neutralizeFirefoxWindow(win: RessacWindow): void {
  hideFirefoxItems(win);
  routeSettingsItems(win);
  routeAddonsToMain(win);
  for (const id of FIREFOX_COMMANDS)
    if (id !== "cmd_close" && !id.startsWith("cmd_newNavigatorTab")) win.document.getElementById(id)?.setAttribute("disabled", "true");
}
