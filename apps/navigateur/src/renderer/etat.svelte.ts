import type { ApiWebaios } from "../commun/api";
import type { DemandeEnAttente, EtatFenetre, EtatNavigateur, Telechargement } from "../commun/modele";

declare global {
  interface Window {
    webaios: ApiWebaios;
  }
}

export const api = window.webaios;

/** Copie locale de l'état diffusé par le process principal ; ne se modifie que via `api.agir`. */
export const etat = $state<{ valeur: EtatNavigateur | null }>({ valeur: null });

api.surEtat((e) => {
  etat.valeur = e;
});

/** L'état de la fenêtre qui affiche cette interface. */
export function fenetreCourante(): EtatFenetre | undefined {
  return etat.valeur?.fenetres.find((f) => f.id === api.fenetreId);
}

/** Téléchargements de la session, le plus récent en tête. */
export const telechargements = $state<{ liste: Telechargement[] }>({ liste: [] });

api.surTelechargements((liste) => {
  telechargements.liste = liste;
});
void api.telechargements.liste().then((liste) => {
  telechargements.liste = liste;
});

/** Questions d'autorisation des sites, en attente d'une réponse. */
export const demandes = $state<{ liste: DemandeEnAttente[] }>({ liste: [] });

api.surPermissions((liste) => {
  demandes.liste = liste;
});
void api.permissions.enAttente().then((liste) => {
  demandes.liste = liste;
});
