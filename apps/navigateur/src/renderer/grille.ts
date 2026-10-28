import type { Placement } from "../commun/api";

export type { Placement };

/** La grille libre de la page d'accueil : 12 colonnes, rangées de 90 px, 12 px entre les cases. */
export const COLONNES = 12;
export const RANGEE_PX = 90;
export const ECART_PX = 12;

type Taille = { l: number; h: number };
export interface Tailles {
  min: Taille;
  max: Taille;
}

const borner = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const chevauchent = (a: Placement, b: Placement) =>
  a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Le widget `fixe` garde sa place ; les autres, pris de haut en bas, descendent juste sous ce qu'ils chevauchent
 * (en cascade). Le résultat n'a aucun chevauchement ; l'ordre de la liste est conservé.
 */
function resoudre(placements: Placement[], fixe: Placement): Placement[] {
  const poses: Placement[] = [fixe];
  const autres = placements
    .filter((q) => q.id !== fixe.id)
    .map((q) => ({ ...q }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const q of autres) {
    for (let gene = poses.find((r) => chevauchent(q, r)); gene; gene = poses.find((r) => chevauchent(q, r))) {
      q.y = gene.y + gene.h;
    }
    poses.push(q);
  }
  const parId = new Map(poses.map((q) => [q.id, q]));
  return placements.map((q) => parId.get(q.id)!);
}

/** Pose le widget `id` en (x, y), dans la grille, et pousse vers le bas ceux qu'il chevauche. */
export function deplacer(placements: Placement[], id: string, x: number, y: number): Placement[] {
  const cible = placements.find((q) => q.id === id);
  if (!cible) return placements;
  const fixe = { ...cible, x: borner(Math.round(x), 0, COLONNES - cible.l), y: Math.max(0, Math.round(y)) };
  return resoudre(placements, fixe);
}

/** Change la taille du widget `id`, bornée par ses tailles min et max et par le bord droit de la grille. */
export function redimensionner(placements: Placement[], id: string, l: number, h: number, tailles: Tailles): Placement[] {
  const cible = placements.find((q) => q.id === id);
  if (!cible) return placements;
  const minL = Math.min(tailles.min.l, COLONNES);
  // Le minimum ne tient pas avant le bord droit : le widget recule.
  const x = Math.min(cible.x, COLONNES - minL);
  const largeur = borner(Math.round(l), minL, Math.min(tailles.max.l, COLONNES - x));
  const hauteur = borner(Math.round(h), tailles.min.h, tailles.max.h);
  return resoudre(placements, { ...cible, x, l: largeur, h: hauteur });
}

/** Nombre de cases (colonnes ou rangées) le plus proche d'une distance en pixels ; `taille` : celle d'une case sans l'écart. */
export function versCase(px: number, taille: number): number {
  return Math.round(px / (taille + ECART_PX)) || 0;
}

/** Délai entre le clic dans un widget et la demande d'ouverture de lien qu'il permet. */
export const DELAI_GESTE_MS = 1000;

/**
 * Un widget ne peut ouvrir un lien que juste après un vrai clic de l'utilisateur dans son cadre, et un seul lien par clic :
 * un widget qui demande un lien à son chargement ou sur une minuterie est ignoré.
 */
export function porteOuvrir(maintenant: () => number = () => Date.now()) {
  const gestes = new Map<string, number>();
  return {
    /** L'utilisateur vient de cliquer dans le cadre du widget `id`. */
    geste(id: string) {
      gestes.set(id, maintenant());
    },
    /** Le widget `id` demande un lien : accepté si un clic récent le permet (et ce clic est consommé). */
    accepter(id: string): boolean {
      const t = gestes.get(id);
      gestes.delete(id);
      return t !== undefined && maintenant() - t <= DELAI_GESTE_MS;
    },
  };
}
