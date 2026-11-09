/** The interface's single context menu (right click in the sidebar). */
export interface EntreeMenu {
  libelle: string;
  agir: () => void;
}

export const menu = $state<{ ouvert: { x: number; y: number; entrees: EntreeMenu[]; libre: boolean } | null }>({ ouvert: null });

/** `libre`: the menu may open over the content area (internal page, which no web view covers). */
export function ouvrirMenu(e: MouseEvent, entrees: EntreeMenu[], o: { libre?: boolean } = {}): void {
  e.preventDefault();
  menu.ouvert = { x: e.clientX, y: e.clientY, entrees, libre: o.libre ?? false };
}

export function fermerMenu(): void {
  menu.ouvert = null;
}
