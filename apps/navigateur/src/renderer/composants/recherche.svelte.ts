import type { ResultatRecherche } from "../../commun/api";

/** Barre de recherche dans la page : ouverte par ⌘F, pilotée aussi par ⌘G / ⇧⌘G depuis le menu. */
export const recherche = $state<{
  ouverte: boolean;
  /** Incrémenté pour redonner le focus au champ. */
  focus: number;
  /** Incrémenté à chaque ⌘G / ⇧⌘G. */
  pas: { n: number; precedent: boolean };
  resultat: ResultatRecherche | null;
}>({ ouverte: false, focus: 0, pas: { n: 0, precedent: false }, resultat: null });
