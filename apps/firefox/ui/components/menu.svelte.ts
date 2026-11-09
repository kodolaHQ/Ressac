/** The interface's single context menu (right click in the sidebar). */
export interface MenuEntry {
  libelle: string;
  agir: () => void;
}

export const menu = $state<{ ouvert: { x: number; y: number; entrees: MenuEntry[]; libre: boolean } | null }>({ ouvert: null });

/** `libre`: the menu may open over the content area (internal page, which no web view covers). */
export function openMenu(e: MouseEvent, entries: MenuEntry[], o: { libre?: boolean } = {}): void {
  e.preventDefault();
  menu.ouvert = { x: e.clientX, y: e.clientY, entrees: entries, libre: o.libre ?? false };
}

export function closeMenu(): void {
  menu.ouvert = null;
}
