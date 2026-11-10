import type { Panel, ShortcutAction } from "../../shared/api";

export type Shortcut =
  | { type: "shortcut"; r: Extract<ShortcutAction, "command" | "address" | "closeTab"> }
  | { type: "reopen" }
  | { type: "nth"; n: number }
  | { type: "space"; n: number }
  | { type: "navigate"; c: "back" | "forward" | "reload" | "reloadHard" }
  | { type: "cycle"; delta: 1 | -1 }
  /** ⌘J: the agent panel (menu item « Panneau agent »). */
  | { type: "agent" }
  /** ⇧⌘S: the sidebar's compact mode (menu item « Mode compact »). */
  | { type: "compact" }
  /** ⌘Y, ⇧⌘J: a UI panel (menu items « Historique » and « Téléchargements »). */
  | { type: "panel"; p: Panel }
  /** ⌘N, ⇧⌘W: a WebAiOs window, through Firefox's own window opening and closing (the window registry binds them). */
  | { type: "window" }
  | { type: "closeWindow" }
  /** ⇧⌘A: the Applications page (menu item « Applications »), not Firefox's add-ons. */
  | { type: "apps" }
  /** ⌘, (menu item « Réglages »): the Settings page, not Firefox's about:preferences. */
  | { type: "settings" }
  /** ⇧⌘D: the design mode of the window in front (menu item « Mode design »), not Firefox's « bookmark all tabs ». */
  | { type: "design" }
  /** Firefox's next/previous tab keys walk every XUL tab, other spaces' too: consumed, nothing done. */
  | { type: "ignore" };

type Keys = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

const COMMAND: Record<string, Shortcut> = {
  t: { type: "shortcut", r: "command" },
  l: { type: "shortcut", r: "address" },
  w: { type: "shortcut", r: "closeTab" },
  "[": { type: "navigate", c: "back" },
  "]": { type: "navigate", c: "forward" },
  r: { type: "navigate", c: "reload" },
  n: { type: "window" },
  j: { type: "agent" },
  y: { type: "panel", p: "history" },
  ",": { type: "settings" },
};
const SHIFT_COMMAND: Record<string, Shortcut> = {
  t: { type: "reopen" },
  r: { type: "navigate", c: "reloadHard" },
  w: { type: "closeWindow" },
  j: { type: "panel", p: "downloads" },
  s: { type: "compact" },
  a: { type: "apps" },
  d: { type: "design" },
};

/** WebAiOs's menu accelerators (macOS: ⌘ is Meta). Digits are read on the physical key: ⌘1 types “&” in AZERTY. */
export function shortcutFor(e: Keys): Shortcut | null {
  // ShortcutUtils' PREVIOUS_TAB/NEXT_TAB (and ⌃⇧PageUp/PageDown, which move the tab) on macOS.
  if (
    (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "PageUp" || e.key === "PageDown")) ||
    (e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey && e.key.startsWith("Arrow")) ||
    (e.metaKey && !e.altKey && !e.ctrlKey && (e.key === "{" || e.key === "}"))
  )
    return { type: "ignore" };
  if (e.altKey || (e.metaKey && e.ctrlKey)) return null;
  const digit = !e.shiftKey && /^Digit([1-9])$/.exec(e.code)?.[1];
  if (e.ctrlKey) {
    if (e.key === "Tab") return { type: "cycle", delta: e.shiftKey ? -1 : 1 };
    return digit ? { type: "space", n: Number(digit) } : null;
  }
  if (!e.metaKey) return null;
  if (digit) return { type: "nth", n: Number(digit) };
  return (e.shiftKey ? SHIFT_COMMAND : COMMAND)[e.key.toLowerCase()] ?? null;
}

/** Firefox's <key>s for the same keys, disabled so that only ours act (⇧⌘T is the restore key, not History:UndoCloseTab). */
export const FIREFOX_KEYS = [
  "key_newNavigatorTab",
  "focusURLBar",
  "key_close",
  "key_newNavigator",
  "key_closeWindow",
  "key_restoreLastClosedTabOrWindowOrSession",
  "goBackKb2",
  "goForwardKb2",
  "key_reload",
  "key_reload_skip_cache",
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `key_selectTab${n}`),
  "key_selectLastTab",
  // ⌘J: Downloads in Firefox.
  "key_openDownloads",
  // ⌘Y, ⇧⌘H (no command: disabling its command is not enough) and ⇧⌘O: Places' library and history sidebar.
  "showAllHistoryKb",
  "key_gotoHistory",
  "manBookmarkKb",
  // ⇧⌘S: Firefox's screenshot.
  "key_screenshot",
  // ⇧⌘A: Firefox's add-ons manager.
  "key_openAddons",
  // ⇧⌘D: Firefox's « bookmark all tabs ».
  "bookmarkAllTabsKb",
];

/** The native Settings menu items: kept in FIREFOX_COMMANDS (site and app windows keep them off), re-enabled in main windows. */
export const SETTINGS_MENU_ITEMS = ["menu_preferences", "menu_settings"];

/**
 * Firefox's <command>s (and macOS menu items) that open or close tabs and windows behind the store's back: disabling a
 * <key> leaves the native menu bar running them. ⌘T, ⌘W and ⇧⌘T keep working through shortcutFor. New Window and Close
 * Window stay: a new full window becomes a WebAiOs window (the window registry), a closed one leaves it.
 */
export const FIREFOX_COMMANDS = [
  "cmd_newNavigatorTab",
  "cmd_newNavigatorTabNoEvent",
  "Browser:NewUserContextTab",
  "Tools:PrivateBrowsing",
  "Tools:AIWindow",
  "Tools:ClassicWindow",
  "cmd_close",
  "History:UndoCloseTab",
  "History:UndoCloseWindow",
  "History:RestoreLastClosedTabOrWindowOrSession",
  // ⌘, (Settings): opens about:preferences as a Firefox tab.
  "menu_preferences",
  "menu_settings",
  // The native menu items for history, bookmarks and downloads (all open Places' library window).
  "Browser:ShowAllHistory",
  "Browser:ShowAllBookmarks",
  "Tools:Downloads",
  // ⇧⌘⌫ (key_sanitize_mac) and History > Clear Recent History: Firefox's sanitize dialog.
  "Tools:Sanitize",
  // Tools > Take Screenshot: its menu item keeps the ⇧⌘S of compact mode.
  "Browser:Screenshot",
  // Bookmarks > Bookmark All Tabs: its menu item keeps the ⇧⌘D of the design mode.
  "Browser:BookmarkAllTabs",
];
