import type { EtatAccesOnglet } from "@webaios/noyau";
import type { ApiWebaios } from "../commun/api";
import type { DemandeEnAttente, EtatAcces, EtatFenetre, EtatNavigateur, Telechargement } from "../commun/modele";

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

/** Accès de l'agent aux onglets (id d'onglet → ce qu'il peut lire ou faire), et nom de l'agent qui les détient. */
export const acces = $state<{ liste: Record<string, EtatAccesOnglet>; agent: string; bullesOuvertes: number }>({ liste: {}, agent: "L'agent", bullesOuvertes: 0 });

let diffuse = false; // une diffusion est plus récente que la réponse initiale : celle-ci est ignorée
const appliquerAcces = (e: EtatAcces) => {
  acces.liste = e.onglets;
  acces.agent = e.agent;
};
api.surAcces((e) => {
  diffuse = true;
  appliquerAcces(e);
});
void api.acces.etat().then((e) => {
  if (!diffuse) appliquerAcces(e);
});

/** L'accès de l'agent à cet onglet, s'il lit la page ou détient un droit (un outil en cours seul ne montre rien). */
export function accesDe(id: string): EtatAccesOnglet | undefined {
  const e = acces.liste[id];
  return e && (e.lecture || e.droits.length) ? e : undefined;
}
