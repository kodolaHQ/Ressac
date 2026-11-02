import type { EtatNavigateur, IdFenetre, IdOnglet } from "../commun/modele";
import { cleEspace } from "../commun/modele";

/** Onglets ouverts que l'espace actif peut afficher, dans l'ordre de la barre latérale : essentiels, épinglés, puis les autres. */
export function ongletsParcourables(etat: EtatNavigateur, fenetreId: IdFenetre): IdOnglet[] {
  const f = etat.fenetres.find((x) => x.id === fenetreId);
  const espace = f && etat.espaces.find((x) => x.id === f.espaceActif);
  if (!f || !espace) return [];
  const cle = cleEspace(etat, espace.id);
  const ouverts = Object.values(etat.onglets).filter((o) => o.fenetreId === f.id);
  const essentiels = etat.essentiels.flatMap((fav) =>
    ouverts.filter((o) => o.lien?.type === "essentiel" && o.lien.id === fav.id && cleEspace(etat, o.espaceId) === cle).map((o) => o.id),
  );
  const epingles = espace.epingles.flatMap((fav) =>
    ouverts.filter((o) => o.lien?.type === "epingle" && o.lien.id === fav.id && o.espaceId === espace.id).map((o) => o.id),
  );
  const vus = new Set<IdOnglet>();
  return [...essentiels, ...epingles, ...(f.ordre[espace.id] ?? [])].filter((id) => !vus.has(id) && !!vus.add(id) && !!etat.onglets[id]);
}

/** L'onglet actif en tête, puis l'historique (récent d'abord) restreint aux onglets parcourables, puis le reste. */
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

/** Nouveau tableau avec `id` en tête, sans doublon. */
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

/** Retire un onglet fermé pendant le parcours ; null s'il en reste moins de 2. */
export function retirer(p: Parcours, id: IdOnglet): Parcours | null {
  const i = p.liste.indexOf(id);
  if (i < 0) return p;
  const liste = p.liste.filter((x) => x !== id);
  if (liste.length < 2) return null;
  const selection = i < p.selection ? p.selection - 1 : p.selection;
  return { liste, selection: Math.min(selection, liste.length - 1) };
}

/** Indices [debut, fin) d'une fenêtre de `taille` cartes contenant la sélection, collée au début tant que possible. */
export function fenetreVisible(p: Parcours, taille = 7): { debut: number; fin: number } {
  const n = p.liste.length;
  if (n <= taille) return { debut: 0, fin: n };
  const debut = Math.max(0, Math.min(p.selection - taille + 1, n - taille));
  return { debut, fin: debut + taille };
}
