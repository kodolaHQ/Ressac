import { browserCommands, type BrowserCommand } from "../../shared/commands";
import { format } from "../../shared/i18n";
import { SHORTCUTS } from "../../shared/shortcuts";
import type { RessacStore } from "../store";
import type { WindowController } from "./controller";

/**
 * « Commandes » in a main window's macOS menu bar, before Fenêtre: Ressac's own features and settings, so the Help
 * menu's search finds them (⌘T's « Commandes » lists the same, from shared/commands.ts). Items are `ressac-command-<id>`.
 * The keys are written in the label, never set as native key equivalents: AppKit would run the command a second time
 * after Ressac's own key handling. The option already chosen is checked.
 */
export function installCommandsMenu(win: Window, store: RessacStore, controller: WindowController): void {
  const doc = win.document as Document & { createXULElement(name: string): Element };
  const bar = doc.getElementById("main-menubar");
  if (!bar) return;
  const menu = doc.createXULElement("menu");
  menu.id = "ressac-commands-menu";
  const popup = doc.createXULElement("menupopup");
  const run = (c: BrowserCommand) => {
    const r = c.run;
    if (r.kind === "shortcut") controller.shortcut(SHORTCUTS[r.id].run);
    else if (r.kind === "dispatch") store.dispatch(r.action);
    else controller.shortcut({ type: "shortcut", r: `settings:${r.section}` });
  };
  const items = new Map<string, Element>();
  let group = "";
  for (const c of browserCommands(store.state)) {
    if (group && c.group !== group) popup.append(doc.createXULElement("menuseparator"));
    group = c.group;
    const item = doc.createXULElement("menuitem");
    item.id = `ressac-command-${c.id}`;
    // Choices show the one chosen; only label() sets it (autocheck would untick the chosen one on a click that changes nothing).
    if (c.group === "setting" && !c.toggle) {
      item.setAttribute("type", "checkbox");
      item.setAttribute("autocheck", "false");
    }
    // Read again on click: a toggle's action depends on the state now.
    item.addEventListener("command", () => {
      const now = browserCommands(store.state).find((x) => x.id === c.id);
      if (now) run(now);
    });
    popup.append(item);
    items.set(c.id, item);
  }
  // Only labels and checks change here, never hidden/collapsed: that rebuilds the native menu under AppKit (0.1.9 crashed on the app menu's).
  const label = () => {
    menu.setAttribute("label", format(store.state.locale, "sidebar-section-commands"));
    for (const c of browserCommands(store.state)) {
      const item = items.get(c.id)!;
      item.setAttribute("label", c.keys ? `${c.label} (${c.keys})` : c.label);
      if (c.group === "setting" && !c.toggle) item.setAttribute("checked", String(c.current));
    }
  };
  label();
  menu.append(popup);
  bar.insertBefore(menu, doc.getElementById("windowMenu"));
  const off = store.subscribe((s, p) => (s.locale !== p.locale || s.settings !== p.settings) && label());
  win.addEventListener("unload", off, { once: true });
}
