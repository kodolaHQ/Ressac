import type { ApiWebaios } from "../commun/api";
import { cibleDeUrlWorkflow, type DemandeEnAttente, type EtatFenetre, type EtatNavigateur, type IdOnglet, type Onglet, type Telechargement } from "../commun/modele";
import { cleCible } from "./constructeur/cible";
import { confirmerFermeture, garderCodesDe } from "./constructeur/codes.svelte";

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
  // Le code non enregistré d'un constructeur dont l'onglet est parti, par n'importe quel chemin, est abandonné.
  garderCodesDe(
    Object.values(e.onglets).flatMap((o) => {
      const cible = o.fenetreId === api.fenetreId ? cibleDeUrlWorkflow(o.url) : null;
      return cible ? [cleCible(cible)] : [];
    }),
  );
});

/** L'état de la fenêtre qui affiche cette interface. */
export function fenetreCourante(): EtatFenetre | undefined {
  return etat.valeur?.fenetres.find((f) => f.id === api.fenetreId);
}

/**
 * Fermeture d'un onglet voulue par l'utilisateur (bouton, menu, clic du milieu, ⌘W) : le constructeur d'un widget avec du code
 * non enregistré demande d'abord, sauf si un autre onglet de la fenêtre montre le même constructeur.
 */
export function fermerOnglet(id: IdOnglet): void {
  const o = etat.valeur?.onglets[id];
  const cible = o ? cibleDeUrlWorkflow(o.url) : null;
  if (o && cible) {
    const autre = Object.values(etat.valeur!.onglets).some((x) => x.id !== id && x.fenetreId === o.fenetreId && x.url === o.url);
    if (!autre && !confirmerFermeture(cleCible(cible))) return;
  }
  api.agir({ type: "fermerOnglet", id });
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

/**
 * La question à poser maintenant dans cette fenêtre, une à la fois dans l'ordre d'arrivée. Une popup pose ses questions
 * sur l'onglet qui l'a ouverte (ongletId) ; sans onglet connu, sur l'onglet actif. Une question de l'agent vise une
 * fenêtre (la sienne), quel que soit l'onglet affiché.
 */
export function demandeDe(fenetre: EtatFenetre | undefined, onglet: Onglet | undefined): DemandeEnAttente | undefined {
  return demandes.liste.find((d) => (d.fenetreId ? d.fenetreId === fenetre?.id : d.ongletId === null || d.ongletId === onglet?.id));
}

export { acces, accesDe } from "./acces.svelte";
