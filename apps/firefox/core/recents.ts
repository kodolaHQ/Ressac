import type { EtatNavigateur, IdFenetre, IdOnglet } from "../shared/modele";
import { ongletsParcourables } from "../shared/onglets-parcourables";

/** The active tab first, then the history (most recent first) restricted to the cycle-able tabs, then the rest. */
export function ordreRecent(etat: EtatNavigateur, fenetreId: IdFenetre, historique: readonly IdOnglet[]): IdOnglet[] {
  const f = etat.fenetres.find((x) => x.id === fenetreId);
  const parcourables = ongletsParcourables(etat, fenetreId);
  const actif = f?.actif[f.espaceActif] ?? null;
  const resultat: IdOnglet[] = [];
  const ajouter = (id: IdOnglet | null | undefined) => {
    if (id && parcourables.includes(id) && !resultat.includes(id)) resultat.push(id);
  };
  ajouter(actif);
  historique.forEach(ajouter);
  parcourables.forEach(ajouter);
  return resultat;
}

/** New array with `id` first, without duplicates. */
export function noterUtilisation(historique: IdOnglet[], id: IdOnglet): IdOnglet[] {
  return [id, ...historique.filter((x) => x !== id)];
}

export type Parcours = { liste: IdOnglet[]; selection: number };

export function demarrer(liste: IdOnglet[], delta: 1 | -1): Parcours | null {
  if (liste.length < 2) return null;
  return { liste, selection: delta > 0 ? 1 : liste.length - 1 };
}

export function avancer(p: Parcours, delta: 1 | -1): Parcours {
  const n = p.liste.length;
  return { ...p, selection: (p.selection + delta + n) % n };
}

/** Removes a tab closed during the cycle; null if fewer than 2 remain. */
export function retirer(p: Parcours, id: IdOnglet): Parcours | null {
  const i = p.liste.indexOf(id);
  if (i < 0) return p;
  const liste = p.liste.filter((x) => x !== id);
  if (liste.length < 2) return null;
  const selection = i < p.selection ? p.selection - 1 : p.selection;
  return { liste, selection: Math.min(selection, liste.length - 1) };
}

/** Indices [debut, fin) of a window of `taille` cards containing the selection, stuck to the start as long as possible. */
export function fenetreVisible(p: Parcours, taille = 7): { debut: number; fin: number } {
  const n = p.liste.length;
  if (n <= taille) return { debut: 0, fin: n };
  const debut = Math.max(0, Math.min(p.selection - taille + 1, n - taille));
  return { debut, fin: debut + taille };
}
