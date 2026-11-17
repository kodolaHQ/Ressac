import { format } from "../../shared/i18n";
import { SHORTCUT_IDS, SHORTCUTS, shortcutLabel, type ShortcutId } from "../../shared/shortcuts";
import type { RessacStore } from "../store";
import type { WindowController } from "./controller";

/** Every Ressac command the menu lists (ids `ressac-command-<id>`): the remappable shortcuts, then vim on/off. */
export const MENU_COMMANDS: (ShortcutId | "vim")[] = [...SHORTCUT_IDS, "vim"];

/**
 * « Commandes » in a main window's macOS menu bar, before Fenêtre: Ressac's own features, so the Help menu's search finds
 * them (⌘T's « Commandes » section lists the same). The keys are written in the label, never set as native key
 * equivalents: AppKit would run the command a second time after Ressac's own key handling.
 */
export function installCommandsMenu(win: Window, store: RessacStore, controller: WindowController): void {
  const doc = win.document as Document & { createXULElement(name: string): Element };
  const bar = doc.getElementById("main-menubar");
  if (!bar) return;
  const menu = doc.createXULElement("menu");
  menu.id = "ressac-commands-menu";
  const popup = doc.createXULElement("menupopup");
  const items = MENU_COMMANDS.map((id) => {
    const item = doc.createXULElement("menuitem");
    item.id = `ressac-command-${id}`;
    item.addEventListener("command", () => {
      if (id === "vim") store.dispatch({ type: "setVimMode", enabled: !store.state.settings.vimMode });
      else controller.shortcut(SHORTCUTS[id].run);
    });
    popup.append(item);
    return [id, item] as const;
  });
  // Only labels change here, never hidden/collapsed: that rebuilds the native menu under AppKit (0.1.9 crashed on the app menu's).
  const label = () => {
    const { locale, settings } = store.state;
    menu.setAttribute("label", format(locale, "sidebar-section-commands"));
    for (const [id, item] of items)
      item.setAttribute(
        "label",
        id === "vim" ? format(locale, settings.vimMode ? "sidebar-command-vim-off" : "sidebar-command-vim-on") : `${format(locale, SHORTCUTS[id].label)} (${shortcutLabel(id, settings)})`,
      );
  };
  label();
  menu.append(popup);
  bar.insertBefore(menu, doc.getElementById("windowMenu"));
  const off = store.subscribe((s, p) => (s.locale !== p.locale || s.settings.vimMode !== p.settings.vimMode || s.settings.shortcuts !== p.settings.shortcuts) && label());
  win.addEventListener("unload", off, { once: true });
}
