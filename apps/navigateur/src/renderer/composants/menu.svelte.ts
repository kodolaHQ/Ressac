/** Menu contextuel unique de l'interface (clic droit dans la barre latérale). */
export interface EntreeMenu {
  libelle: string;
  agir: () => void;
}

export const menu = $state<{ ouvert: { x: number; y: number; entrees: EntreeMenu[]; libre: boolean } | null }>({ ouvert: null });

/** `libre` : le menu peut s'ouvrir sur la zone de contenu (page interne, qu'aucune vue web ne couvre). */
export function ouvrirMenu(e: MouseEvent, entrees: EntreeMenu[], o: { libre?: boolean } = {}): void {
  e.preventDefault();
  menu.ouvert = { x: e.clientX, y: e.clientY, entrees, libre: o.libre ?? false };
}

export function fermerMenu(): void {
  menu.ouvert = null;
}
