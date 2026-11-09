import type { IdEspace } from "../../shared/modele";
import type { ChoixProfil } from "./profilsEspace";

/** Settings of a space in progress in the modal (`id` null: a new space). */
export interface BrouillonEspace {
  id: IdEspace | null;
  nom: string;
  icone: string;
  prive: boolean;
  profil: ChoixProfil;
}

/**
 * Modal for a space's settings, mounted at window level (App.svelte). The draft lives here: if an agent request comes
 * in front, the modal closes for the time of the request and comes back with what was typed.
 */
export const reglagesEspace = $state<{ brouillon: BrouillonEspace | null }>({ brouillon: null });
