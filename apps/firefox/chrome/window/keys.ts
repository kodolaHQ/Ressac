import type { Raccourci } from "../../../navigateur/src/commun/api";

export type Shortcut =
  | { type: "raccourci"; r: Extract<Raccourci, "commande" | "adresse" | "fermerOnglet"> }
  | { type: "rouvrir" }
  | { type: "nieme"; n: number }
  | { type: "espace"; n: number }
  | { type: "naviguer"; c: "reculer" | "avancer" | "recharger" | "rechargerSansCache" }
  | { type: "parcourir"; delta: 1 | -1 }
  | { type: "rien" };

type Keys = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

const COMMAND: Record<string, Shortcut> = {
  t: { type: "raccourci", r: "commande" },
  l: { type: "raccourci", r: "adresse" },
  w: { type: "raccourci", r: "fermerOnglet" },
  "[": { type: "naviguer", c: "reculer" },
  "]": { type: "naviguer", c: "avancer" },
  r: { type: "naviguer", c: "recharger" },
  n: { type: "rien" },
};
const SHIFT_COMMAND: Record<string, Shortcut> = {
  t: { type: "rouvrir" },
  r: { type: "naviguer", c: "rechargerSansCache" },
};

/** The Electron menu accelerators (macOS: ⌘ is Meta). Digits are read on the physical key: ⌘1 types “&” in AZERTY. */
export function shortcutFor(e: Keys): Shortcut | null {
  if (e.altKey || (e.metaKey && e.ctrlKey)) return null;
  const digit = !e.shiftKey && /^Digit([1-9])$/.exec(e.code)?.[1];
  if (e.ctrlKey) {
    if (e.key === "Tab") return { type: "parcourir", delta: e.shiftKey ? -1 : 1 };
    return digit ? { type: "espace", n: Number(digit) } : null;
  }
  if (!e.metaKey) return null;
  if (digit) return { type: "nieme", n: Number(digit) };
  return (e.shiftKey ? SHIFT_COMMAND : COMMAND)[e.key.toLowerCase()] ?? null;
}

/** Firefox's <key>s for the same keys, disabled so that only ours act (⇧⌘T is the restore key, not History:UndoCloseTab). */
export const FIREFOX_KEYS = [
  "key_newNavigatorTab",
  "focusURLBar",
  "key_close",
  "key_newNavigator",
  "key_restoreLastClosedTabOrWindowOrSession",
  "goBackKb2",
  "goForwardKb2",
  "key_reload",
  "key_reload_skip_cache",
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `key_selectTab${n}`),
  "key_selectLastTab",
];

/**
 * Firefox's <command>s (and macOS menu items) that open or close tabs and windows behind the store's back: disabling a
 * <key> leaves the native menu bar running them. ⌘T, ⌘W and ⇧⌘T keep working through shortcutFor.
 */
export const FIREFOX_COMMANDS = [
  "cmd_newNavigatorTab",
  "cmd_newNavigatorTabNoEvent",
  "Browser:NewUserContextTab",
  "cmd_newNavigator",
  "Tools:PrivateBrowsing",
  "Tools:AIWindow",
  "Tools:ClassicWindow",
  "cmd_close",
  "cmd_closeWindow",
  "History:UndoCloseTab",
  "History:UndoCloseWindow",
  "History:RestoreLastClosedTabOrWindowOrSession",
  // ⌘, (Settings): opens about:preferences as a Firefox tab.
  "menu_preferences",
  "menu_settings",
];
