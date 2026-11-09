import { jsonCanonique } from "../workflows/memoire.js";

/**
 * What counts as a widget's novelties: the items of its data (the list, or the first-level lists
 * of an object) that were not in its previous data. A notification's text never takes anything
 * from this data: only their number.
 */

/** The items of the data: the list itself, or the first-level lists of an object, one after the other. */
export function elementsDe(donnees: unknown): unknown[] {
  if (Array.isArray(donnees)) return donnees;
  if (donnees === null || typeof donnees !== "object") return [];
  return Object.values(donnees).flatMap((v) => (Array.isArray(v) ? v : []));
}

/** An item's identity: its `url` when it is text (a changed price does not make it new), otherwise its canonical JSON. */
export function identite(e: unknown): string {
  if (e !== null && typeof e === "object" && !Array.isArray(e)) {
    const url = (e as Record<string, unknown>).url;
    if (typeof url === "string") return url;
  }
  return jsonCanonique(e);
}

/** Number of (distinct) items of the data that were not in the previous ones. */
export function compterNouveaux(precedent: unknown, donnees: unknown): number {
  const vus = new Set(elementsDe(precedent).map(identite));
  const nouveaux = new Set(elementsDe(donnees).map(identite).filter((i) => !vus.has(i)));
  return nouveaux.size;
}

export function texteNotification(n: number): string {
  return n === 1 ? "1 nouvel élément" : `${n} nouveaux éléments`;
}

/** What the notification at the end of a watch shows: `titre` = widget name, `texte` = `texteNotification(n)`. */
export type NotificationWidget = { widget: string; titre: string; texte: string };
