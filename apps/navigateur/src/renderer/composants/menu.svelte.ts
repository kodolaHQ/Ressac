/** Menu contextuel unique de l'interface (clic droit dans la barre latérale). */
export interface EntreeMenu {
  libelle: string;
  agir: () => void;
}

export const menu = $state<{ ouvert: { x: number; y: number; entrees: EntreeMenu[] } | null }>({ ouvert: null });

export function ouvrirMenu(e: MouseEvent, entrees: EntreeMenu[]): void {
  e.preventDefault();
  menu.ouvert = { x: e.clientX, y: e.clientY, entrees };
}

export function fermerMenu(): void {
  menu.ouvert = null;
}
