import { jsonCanonique } from "../workflows/memoire.js";

/**
 * Ce qui compte comme les nouveautés d'un widget : les éléments de ses données (la liste, ou les listes au premier
 * niveau d'un objet) qui n'étaient pas dans ses données d'avant. Le texte d'une notification ne reprend jamais rien
 * de ces données : seulement leur nombre.
 */

/** Les éléments des données : la liste elle-même, ou les listes au premier niveau d'un objet, à la suite. */
export function elementsDe(donnees: unknown): unknown[] {
  if (Array.isArray(donnees)) return donnees;
  if (donnees === null || typeof donnees !== "object") return [];
  return Object.values(donnees).flatMap((v) => (Array.isArray(v) ? v : []));
}

/** L'identité d'un élément : son `url` quand c'est du texte (un prix changé ne le rend pas nouveau), sinon son JSON canonique. */
export function identite(e: unknown): string {
  if (e !== null && typeof e === "object" && !Array.isArray(e)) {
    const url = (e as Record<string, unknown>).url;
    if (typeof url === "string") return url;
  }
  return jsonCanonique(e);
}

/** Nombre d'éléments (distincts) des données qui n'étaient pas dans les précédentes. */
export function compterNouveaux(precedent: unknown, donnees: unknown): number {
  const vus = new Set(elementsDe(precedent).map(identite));
  const nouveaux = new Set(elementsDe(donnees).map(identite).filter((i) => !vus.has(i)));
  return nouveaux.size;
}

export function texteNotification(n: number): string {
  return n === 1 ? "1 nouvel élément" : `${n} nouveaux éléments`;
}
