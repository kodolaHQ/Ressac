import type { BrowserWindow } from "electron";
import { creerNoyau, type Noyau, type OngletInfo } from "@webaios/noyau";
import type { IdFenetre } from "../../commun/modele";
import type { Magasin } from "../ipc";
import type { GestionnaireVues } from "../onglets/vues";
import { changementsPolitique, PontElectron } from "./pont";
import { SessionsAgent } from "./sessions";
import { CANAUX } from "../../commun/canaux";

declare const __RESSOURCES_NOYAU__: string;

export interface ServiceAgent {
  /** null tant que le noyau n'est pas prêt, ou s'il n'a pas pu démarrer (voir `erreur`). */
  noyau(): Noyau | null;
  erreur(): string | null;
  /** Terminaux de l'agent, un par fenêtre. */
  sessions: SessionsAgent;
  arreter(): Promise<void>;
}


/**
 * Démarre le noyau en tâche de fond : la navigation n'attend jamais l'agent (spec §9), et une erreur
 * du noyau (port, profil illisible…) ne concerne que le panneau agent.
 */
export function demarrerAgent(o: {
  magasin: Magasin;
  vues: GestionnaireVues;
  fenetres: Map<IdFenetre, BrowserWindow>;
  fenetreActive: () => IdFenetre | undefined;
  /** Demande de lecture affichée à l'utilisateur (voir index.ts). */
  demanderLecture: (o: OngletInfo) => Promise<boolean>;
}): ServiceAgent {
  let noyau: Noyau | null = null;
  let erreur: string | null = null;
  const pont = new PontElectron({ magasin: o.magasin, vues: o.vues, fenetreActive: o.fenetreActive, demander: o.demanderLecture });
  // La politique d'accès suit ce que fait l'utilisateur : changer de site ou fermer un onglet retire l'accès (spec §8.2).
  o.magasin.abonner((etat, avant) => {
    if (!noyau) return;
    const { navigues, fermes } = changementsPolitique(avant, etat);
    for (const n of navigues) noyau.politique.ongletNavigue(n.id, n.url);
    for (const id of fermes) noyau.politique.ongletFerme(id);
  });
  const pret = creerNoyau({ pont, ressources: __RESSOURCES_NOYAU__ }).then(
    (n) => (noyau = n),
    (e: Error) => {
      erreur = e.message;
      console.error("[webaios] le noyau n'a pas pu démarrer :", e);
      return null;
    },
  );
  const sessions = new SessionsAgent({
    async ouvrir(t) {
      const n = await pret;
      if (!n) throw new Error(erreur ?? "le noyau de l'agent n'a pas démarré");
      return n.ouvrirSessionAgent(t);
    },
    envoyer: (f, canal, v) => {
      const w = o.fenetres.get(f);
      if (w && !w.isDestroyed()) w.webContents.send(canal === "donnees" ? CANAUX.agentDonnees : CANAUX.agentEtat, v);
    },
  });
  return {
    noyau: () => noyau,
    erreur: () => erreur,
    sessions,
    async arreter() {
      sessions.toutArreter();
      await (await pret)?.arreter();
    },
  };
}
