import type { PlacementLibre } from "../../../packages/noyau/src/accueil/schemas";

// Gestes de l'accueil libre (millièmes en largeur, pixels en hauteur). Le placement des widgets sans position est fait
// par le noyau (placerManquantsLibre) : ici, seulement l'aimantation, les guides et les bornes du geste.
/** Pas d'aimantation horizontal, en millièmes de largeur. */
export const PAS_X = 5;
/** Pas d'aimantation vertical, en pixels. */
export const PAS_Y = 8;
/** Millièmes de la largeur de l'accueil (même valeur que le noyau ; recopiée pour ne pas charger zod dans l'interface). */
export const LARGEUR_LIBRE = 1000;
/** Colonnes et rangées déclarées par un widget : la taille envoyée à l'affichage est arrondie en ces unités. */
export const COLONNES = 12;
export const RANGEE_PX = 90;

const borner = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));
const aimantX = (x: number) => Math.round(x / PAS_X) * PAS_X;
const aimantY = (y: number) => Math.round(y / PAS_Y) * PAS_Y;

const chevauchent = (a: PlacementLibre, b: PlacementLibre) => a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.h && b.y < a.y + a.h;

/** Tailles déclarées (unités 1…12) vers les unités libres (millièmes, pixels) : la copie de `taillesLibres` du noyau. */
export function taillesLibres(t: { l: number; h: number }): { l: number; h: number } {
  return { l: Math.max(1, Math.round((t.l * LARGEUR_LIBRE) / COLONNES)), h: Math.max(1, t.h * RANGEE_PX) };
}

/** L'inverse : la taille réelle (millièmes, pixels) en unités arrondies, pour `postMessage`. */
export function unitesLibres(t: { l: number; h: number }): { l: number; h: number } {
  return { l: Math.max(1, Math.round((t.l * COLONNES) / LARGEUR_LIBRE)), h: Math.max(1, Math.round(t.h / RANGEE_PX)) };
}

/**
 * La place du widget `p` s'il était lâché en (x, y) : aimanté, dans l'accueil, et arrêté au bord d'un autre widget sans
 * le déplacer (le déplacement pousse l'aperçu hors des autres, il ne les tasse pas).
 */
export function deplacerLibre(o: { p: PlacementLibre; x: number; y: number; autres: readonly PlacementLibre[]; largeurPx: number }): PlacementLibre {
  const { p, autres, largeurPx } = o;
  let x = borner(aimantX(o.x), 0, LARGEUR_LIBRE - p.l);
  let y = Math.max(0, aimantY(o.y));
  // Plusieurs murs peuvent se suivre : on refait un tour tant qu'un autre widget est touché.
  for (let tour = 0; tour < 8; tour++) {
    const gene = autres.find((a) => a.id !== p.id && chevauchent({ ...p, x, y }, a));
    if (!gene) break;
    const dx = x - p.x;
    const dy = y - p.y;
    const bornerX = () => {
      if (dx > 0) x = Math.min(x, Math.max(p.x, gene.x - p.l));
      else if (dx < 0) x = Math.min(p.x, Math.max(x, gene.x + gene.l));
    };
    const bornerY = () => {
      if (dy > 0) y = Math.min(y, Math.max(p.y, gene.y - p.h));
      else if (dy < 0) y = Math.min(p.y, Math.max(y, gene.y + gene.h));
    };
    // Le dernier bord touché gagne : l'axe qui a bougé le plus se borne d'abord, l'autre seulement si le chevauchement
    // reste (un glisser diagonal ne saute pas au coin du voisin). Les deux axes se comparent en pixels.
    if (Math.abs(dx) * largeurPx >= Math.abs(dy) * LARGEUR_LIBRE) {
      bornerX();
      if (chevauchent({ ...p, x, y }, gene)) bornerY();
    } else {
      bornerY();
      if (chevauchent({ ...p, x, y }, gene)) bornerX();
    }
  }
  // Un arrêt sur un bord gauche venu de la droite peut viser le bord droit de l'accueil : on y reste.
  x = borner(x, 0, LARGEUR_LIBRE - p.l);
  return { ...p, x, y };
}

/**
 * La taille du widget `p` après un geste : bornée entre min et max, jamais au-delà du bord droit de l'accueil, et
 * arrêtée au bord gauche d'un voisin à sa droite ou au bord haut d'un voisin qui croise sa largeur, à gauche comme à
 * droite (jamais de chevauchement écrit).
 */
export function redimensionnerLibre(o: {
  p: PlacementLibre;
  l: number;
  h: number;
  min: { l: number; h: number };
  max: { l: number; h: number };
  autres: readonly PlacementLibre[];
}): PlacementLibre {
  const { p, min, max, autres } = o;
  const minL = Math.max(1, Math.min(min.l, LARGEUR_LIBRE));
  // Hauteur demandée : elle sert à savoir quels voisins croisent la hauteur pendant le calcul de la largeur.
  const hSouhaite = borner(aimantY(o.h), Math.max(1, min.h), max.h);
  // Seuls les voisins sur les rangées actuelles barrent la largeur : un voisin plus bas est arrêté par le calcul de h.
  const vertical = (a: PlacementLibre) => a.id !== p.id && a.y < p.y + p.h && p.y < a.y + a.h;
  const bord = (depuis: number) => Math.min(LARGEUR_LIBRE, ...autres.filter((a) => vertical(a) && a.x >= depuis).map((a) => a.x));
  // Le minimum ne tient pas avant le voisin (ou le bord droit) : le widget recule au lieu de descendre sous son
  // minimum, comme la grille d'Electron. Il recule sans entrer dans un voisin à sa gauche.
  const gauche = Math.max(0, ...autres.filter((a) => vertical(a) && a.x + a.l <= p.x).map((a) => a.x + a.l));
  const x = Math.max(gauche, Math.min(p.x, bord(p.x) - minL));
  const droite = bord(x);
  const xFinal = Math.max(gauche, Math.min(x, droite - minL));
  const maxL = Math.max(1, Math.min(max.l, droite - xFinal));
  const l = borner(aimantX(o.l), Math.max(1, Math.min(minL, maxL)), maxL);
  // Grandir vers le bas touche un voisin dès que les largeurs se croisent, qu'il soit à gauche ou à droite.
  const dessous = autres
    .filter((a) => a.id !== p.id && a.x < xFinal + l && xFinal < a.x + a.l && a.y >= p.y)
    .map((a) => a.y - p.y);
  const hMax = Math.max(1, Math.min(max.h, ...dessous));
  return {
    ...p,
    x: xFinal,
    l,
    h: borner(hSouhaite, Math.max(1, min.h), hMax),
  };
}

/**
 * Les guides à dessiner pour l'aperçu `p`, en pixels : un trait par bord ou centre aligné avec un autre widget, ou avec
 * les marges ou le centre de l'accueil. Les alignements sont cherchés à 1 px près (l'aimantation laisse un écart).
 */
export function guidesLibres(o: { p: PlacementLibre; autres: readonly PlacementLibre[]; largeurPx: number }): { x: number[]; y: number[] } {
  const { p, autres, largeurPx } = o;
  const px = (milliemes: number) => (milliemes / LARGEUR_LIBRE) * largeurPx;
  const autresX = autres.filter((a) => a.id !== p.id);
  const ciblesX = [0, largeurPx / 2, largeurPx, ...autresX.flatMap((a) => [px(a.x), px(a.x + a.l / 2), px(a.x + a.l)])];
  const ciblesY = autresX.flatMap((a) => [a.y, a.y + a.h / 2, a.y + a.h]);
  const alignes = (valeurs: number[], cibles: number[]) =>
    [...new Set(valeurs.filter((v) => cibles.some((c) => Math.abs(c - v) <= 1)).map((v) => Math.round(v * 100) / 100))];
  return {
    x: alignes([px(p.x), px(p.x + p.l / 2), px(p.x + p.l)], ciblesX),
    y: alignes([p.y, p.y + p.h / 2, p.y + p.h], ciblesY),
  };
}
