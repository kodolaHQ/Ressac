import type { BrowserWindow } from "electron";
import { creerNoyau, type Noyau, type PontNavigateur } from "@webaios/noyau";
import type { IdFenetre } from "../../commun/modele";
import type { Magasin } from "../ipc";
import type { GestionnaireVues } from "../onglets/vues";

declare const __RESSOURCES_NOYAU__: string;

export interface ServiceAgent {
  /** null tant que le noyau n'est pas prêt, ou s'il n'a pas pu démarrer (voir `erreur`). */
  noyau(): Noyau | null;
  erreur(): string | null;
  arreter(): Promise<void>;
}

/** Pont provisoire : remplacé par PontElectron (tâche 2). */
const PONT_VIDE: PontNavigateur = {
  ongletActif: async () => null,
  listerOnglets: async () => [],
  lireTexte: async (id) => Promise.reject(new Error(`Onglet introuvable : ${id}`)),
  ouvrirOnglet: async () => Promise.reject(new Error("indisponible")),
  naviguer: async () => {},
  capturer: async () => Buffer.alloc(0),
  demanderAutorisation: async () => false,
};

/**
 * Démarre le noyau en tâche de fond : la navigation n'attend jamais l'agent (spec §9), et une erreur
 * du noyau (port, profil illisible…) ne concerne que le panneau agent.
 */
export function demarrerAgent(_o: { magasin: Magasin; vues: GestionnaireVues; fenetres: Map<IdFenetre, BrowserWindow> }): ServiceAgent {
  let noyau: Noyau | null = null;
  let erreur: string | null = null;
  const pret = creerNoyau({ pont: PONT_VIDE, ressources: __RESSOURCES_NOYAU__ }).then(
    (n) => (noyau = n),
    (e: Error) => {
      erreur = e.message;
      console.error("[webaios] le noyau n'a pas pu démarrer :", e);
      return null;
    },
  );
  return {
    noyau: () => noyau,
    erreur: () => erreur,
    async arreter() {
      await (await pret)?.arreter();
    },
  };
}
