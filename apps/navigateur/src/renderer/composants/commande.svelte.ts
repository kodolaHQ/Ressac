import { api } from "../etat.svelte";

/**
 * Barre de commande (⌘T, ⌘L). `mode` : "nouveau" ouvre dans un nouvel onglet, "actif" remplace la page de l'onglet
 * actif. `texte` : saisie de départ. Chaque ouverture crée un nouvel objet : rouvrir en cours de route réinitialise la saisie.
 */
export const commande = $state<{ ouverte: null | { mode: "nouveau" | "actif"; texte: string } }>({ ouverte: null });

export function ouvrirCommande(mode: "nouveau" | "actif", texte = ""): void {
  commande.ouverte = { mode, texte };
}

/** `rendreFocus` : le clavier retourne à la page affichée (Échap, clic sur le voile, validation). */
export function fermerCommande(rendreFocus = false): void {
  if (!commande.ouverte) return;
  commande.ouverte = null;
  if (rendreFocus) api.rendreFocusPage();
}
