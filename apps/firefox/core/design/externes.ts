import { rm } from "node:fs/promises";
import {
  UNREADABLE_WARNING,
  pluggedCommand,
  startExternalServer,
  ReviewStore,
  reviewStore,
  commentsFile,
  portTaken,
  externalProject,
  type DossiersDesign,
  type ExternalRegistry,
  type Remarques,
  type DeclarationResult,
} from "@webaios/noyau";
import type { EtatExternes } from "../../shared/api";

const NOM_PAR_DEFAUT = "Claude Code";
const NOM_MAX = 60;

/** Reason displayed when the external MCP does not start (other than a taken port) or its registry is unreadable. */
export const raisonEchec = (e: unknown): string => `Le MCP externe n'a pas pu démarrer : ${e instanceof Error ? e.message : String(e)}`;

export interface ServiceExternes {
  etat(): EtatExternes;
  brancher(nom: string): Promise<{ commande: string }>;
  revoquer(id: string): Promise<void>;
  oublier(id: string): Promise<void>;
  arreter(): Promise<void>;
}

/**
 * The external MCP: the local server (never another port than the one requested), a project's declaration by a Claude
 * Code (registry, first review snapshot, notification) and the Applications page's gestures.
 */
export async function demarrerExternes(o: {
  registre: ExternalRegistry;
  remarques: Remarques;
  dossiers: DossiersDesign;
  port: number;
  plages: [number, number][];
  racineEspace: string;
  maison: string;
  /** Notification of a project's first declaration. */
  notifier(n: { titre: string; texte: string }): void;
}): Promise<ServiceExternes> {
  let serveur: { port: number; arreter(): Promise<void> } | null = null;
  let etatServeur: EtatExternes["serveur"];
  try {
    serveur = await startExternalServer({
      registre: o.registre,
      remarques: o.remarques,
      port: o.port,
      declarer: async (client, d): Promise<DeclarationResult> => {
        const r = await o.registre.declarer(client.id, d, { plages: o.plages, racineEspace: o.racineEspace, maison: o.maison });
        if (r.lisible) {
          // The review's first snapshot is taken in the background: an error does not prevent the declaration.
          const id = externalProject(r.projet.id);
          void new ReviewStore({ depot: reviewStore(o.dossiers, id), dossier: r.projet.dossier })
            .assurerReference()
            .catch((e) => console.error("[externes] première photo de relecture impossible :", e));
        }
        if (r.premiere) o.notifier({ titre: "WebAiOs", texte: `${client.nom} a branché le projet ${r.projet.nom}` });
        return { projet: r.projet, ...(r.lisible ? {} : { avertissement: UNREADABLE_WARNING }) };
      },
    });
    etatServeur = { etat: "pret", port: serveur.port };
  } catch (e) {
    // Port taken or any other error: the section says so, never « démarre » endlessly.
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") etatServeur = { etat: "eteint", raison: portTaken(o.port) };
    else {
      console.error("[externes] démarrage impossible :", e);
      etatServeur = { etat: "eteint", raison: raisonEchec(e) };
    }
  }

  return {
    etat: () => {
      const clients = o.registre.clients();
      return {
        serveur: etatServeur,
        projets: o.registre.projets().map((p) => ({ ...p, client: p.client, nomClient: clients.find((c) => c.id === p.client)?.nom ?? null })),
        clients: clients.map((c) => ({ id: c.id, nom: c.nom, cree: c.cree })),
      };
    },
    brancher: async (nom) => {
      if (etatServeur.etat !== "pret") throw new Error(etatServeur.raison);
      const propre = nom.trim().slice(0, NOM_MAX) || NOM_PAR_DEFAUT;
      const { jeton } = await o.registre.brancher(propre);
      return { commande: pluggedCommand(etatServeur.port, jeton) };
    },
    revoquer: (id) => o.registre.revoquer(id),
    oublier: async (id) => {
      const projet = externalProject(id);
      await o.registre.oublier(id);
      await o.remarques.oublier(projet);
      await Promise.all([
        // Through the repository queue: goes after a first snapshot in progress, which would otherwise recreate it.
        new ReviewStore({ depot: reviewStore(o.dossiers, projet), dossier: o.racineEspace }).supprimer(),
        rm(commentsFile(o.dossiers, projet), { force: true }),
      ]);
    },
    arreter: async () => {
      await serveur?.arreter();
    },
  };
}
