import { join } from "node:path";
import { cheminDansConteneur, cheminsEspace, type CheminsEspace } from "./chemins.js";
import { initialiserEspace } from "./espace/initialiser.js";
import { lireAccueil } from "./accueil/lire.js";
import type { EtatAccueil } from "./accueil/schemas.js";
import { surveillerAccueil } from "./accueil/surveiller.js";
import { chargerProfils, construireCommande } from "./profils/profil.js";
import { ecrireConfigMcp } from "./profils/config-mcp.js";
import { Atelier, type EtatAtelier } from "./conteneur/atelier.js";
import { executeurParDefaut, type Executeur } from "./conteneur/executeur.js";
import { SessionAgent } from "./pty/session.js";
import { PolitiqueAcces } from "./acces/politique.js";
import type { PontNavigateur } from "./mcp/pont.js";
import { demarrerServeurMcp, genererJeton } from "./mcp/serveur.js";
import { PlanificateurVeille } from "./veille/planificateur.js";

export class ErreurAtelier extends Error {
  constructor(readonly etat: EtatAtelier, detail?: string) {
    super(detail ?? (etat === "docker-absent" ? "Docker n'est pas lancé" : `Conteneur indisponible (${etat})`));
    this.name = "ErreurAtelier";
  }
}

export interface Noyau {
  chemins: CheminsEspace;
  politique: PolitiqueAcces;
  etatAtelier(): Promise<EtatAtelier>;
  /** Nouvelle conversation : efface les autorisations. Signaler l'onglet courant (interactionUtilisateur) après. */
  ouvrirSessionAgent(o: { cols: number; rows: number }): Promise<SessionAgent>;
  lireAccueil(): Promise<EtatAccueil>;
  surveillerAccueil(rappel: () => void): () => Promise<void>;
  arreter(): Promise<void>;
}

/** Point d'entrée unique pour un navigateur (Electron, extension…) : il fournit son pont, le noyau fait le reste. */
export async function creerNoyau(o: {
  pont: PontNavigateur;
  racine?: string;
  executer?: Executeur;
  horloge?: () => Date;
  profilId?: string;
  /** Dossier contenant `modeles/` et `docker/` (par défaut, ceux du paquet). */
  ressources?: string;
}): Promise<Noyau> {
  const chemins = cheminsEspace(o.racine);
  const executer = o.executer ?? executeurParDefaut;
  await initialiserEspace(chemins, o.ressources ? join(o.ressources, "modeles") : undefined);

  const profilId = o.profilId ?? "claude";
  const profil = (await chargerProfils(chemins)).profils.find((p) => p.id === profilId);
  if (!profil) throw new Error(`Profil d'agent inconnu : ${profilId}`);

  const politique = new PolitiqueAcces();
  const jeton = genererJeton();
  const serveur = await demarrerServeurMcp({ pont: o.pont, politique, jeton });
  try {
    await ecrireConfigMcp(chemins, profil.configMcp, { url: serveur.urlConteneur, jeton });
  } catch (e) {
    await serveur.arreter();
    throw e;
  }

  // La navigation ne doit jamais attendre Docker (spec §9) : la première construction d'image prend
  // des minutes, et un échec (port occupé…) ne concerne que l'agent.
  const atelier = new Atelier({ chemins, executer, ...(o.ressources ? { dossierDocker: join(o.ressources, "docker") } : {}) });
  const demarrage = atelier.assurerDemarre().catch(() => undefined);
  const planificateur = new PlanificateurVeille({ chemins, atelier, profil, executer, horloge: o.horloge });
  await planificateur.demarrer();

  return {
    chemins,
    politique,
    etatAtelier: () => atelier.etat(),
    async ouvrirSessionAgent({ cols, rows }) {
      await demarrage;
      let etat: EtatAtelier;
      try {
        etat = await atelier.assurerDemarre();
      } catch (e) {
        throw new ErreurAtelier("absent", (e as Error).message);
      }
      if (etat !== "demarre") throw new ErreurAtelier(etat);
      politique.reinitialiser(); // nouvelle conversation
      const commande = construireCommande(profil, "interactif", { mcpConfig: cheminDansConteneur(chemins.configMcp, chemins) });
      return SessionAgent.demarrer(atelier.commandeExec(commande, { interactif: true }), { cols, rows });
    },
    lireAccueil: () => lireAccueil(chemins),
    surveillerAccueil: (rappel) => surveillerAccueil(chemins, rappel),
    async arreter() {
      planificateur.arreter();
      await serveur.arreter();
    },
  };
}
