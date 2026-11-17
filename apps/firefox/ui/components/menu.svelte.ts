/** The interface's single context menu (right click in the sidebar). */
export interface MenuEntry {
  label: string;
  dispatch: () => void;
  /** A choice among several (a radio item): ticked when it is the current one. */
  checked?: boolean;
  disabled?: boolean;
}

export const menu = $state<{ open: { x: number; y: number; inputs: MenuEntry[]; free: boolean } | null }>({ open: null });

/** `libre`: the menu may open over the content area (internal page, which no web view covers). */
export function openMenu(e: MouseEvent, entries: MenuEntry[], o: { free?: boolean } = {}): void {
  e.preventDefault();
  menu.open = { x: e.clientX, y: e.clientY, inputs: entries, free: o.free ?? false };
}

export function closeMenu(): void {
  menu.open = null;
}
