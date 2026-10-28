import type { IdEspace } from "../../commun/modele";
import type { ChoixProfil } from "./profilsEspace";

/** Réglages d'un espace en cours dans la modale (`id` null : un nouvel espace). */
export interface BrouillonEspace {
  id: IdEspace | null;
  nom: string;
  icone: string;
  prive: boolean;
  profil: ChoixProfil;
}

/**
 * Modale des réglages d'un espace, montée au niveau de la fenêtre (App.svelte). Le brouillon vit ici : si une demande
 * de l'agent passe devant, la modale se referme le temps de la demande et revient avec ce qui était saisi.
 */
export const reglagesEspace = $state<{ brouillon: BrouillonEspace | null }>({ brouillon: null });
