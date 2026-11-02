import { rm } from "node:fs/promises";
import {
  AVERTISSEMENT_ILLISIBLE,
  commandeBranchement,
  demarrerServeurExterne,
  DepotRelecture,
  depotRelecture,
  fichierCommentaires,
  portPris,
  projetExterne,
  type DossiersDesign,
  type RegistreExternes,
  type Remarques,
  type ResultatDeclaration,
} from "@webaios/noyau";
import type { EtatExternes } from "../../commun/api";

const NOM_PAR_DEFAUT = "Claude Code";
const NOM_MAX = 60;

export interface ServiceExternes {
  etat(): EtatExternes;
  brancher(nom: string): Promise<{ commande: string }>;
  revoquer(id: string): Promise<void>;
  oublier(id: string): Promise<void>;
  arreter(): Promise<void>;
}

/**
 * Le MCP externe : le serveur local (jamais un autre port que celui demandé), la déclaration d'un projet par un Claude
 * Code (registre, première photo de relecture, notification) et les gestes de la page Applications.
 */
export async function demarrerExternes(o: {
  registre: RegistreExternes;
  remarques: Remarques;
  dossiers: DossiersDesign;
  port: number;
  plages: [number, number][];
  racineEspace: string;
  maison: string;
  /** Notification de la première déclaration d'un projet. */
  notifier(n: { titre: string; texte: string }): void;
}): Promise<ServiceExternes> {
  let serveur: { port: number; arreter(): Promise<void> } | null = null;
  let etatServeur: EtatExternes["serveur"];
  try {
    serveur = await demarrerServeurExterne({
      registre: o.registre,
      remarques: o.remarques,
      port: o.port,
      declarer: async (client, d): Promise<ResultatDeclaration> => {
        const r = await o.registre.declarer(client.id, d, { plages: o.plages, racineEspace: o.racineEspace, maison: o.maison });
        if (r.lisible) {
          // La première photo de la relecture se prend en tâche de fond : une erreur n'empêche pas la déclaration.
          const id = projetExterne(r.projet.id);
          void new DepotRelecture({ depot: depotRelecture(o.dossiers, id), dossier: r.projet.dossier })
            .assurerReference()
            .catch((e) => console.error("[externes] première photo de relecture impossible :", e));
        }
        if (r.premiere) o.notifier({ titre: "WebAiOs", texte: `${client.nom} a branché le projet ${r.projet.nom}` });
        return { projet: r.projet, ...(r.lisible ? {} : { avertissement: AVERTISSEMENT_ILLISIBLE }) };
      },
    });
    etatServeur = { etat: "pret", port: serveur.port };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    etatServeur = { etat: "eteint", raison: portPris(o.port) };
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
      return { commande: commandeBranchement(etatServeur.port, jeton) };
    },
    revoquer: (id) => o.registre.revoquer(id),
    oublier: async (id) => {
      const projet = projetExterne(id);
      await o.registre.oublier(id);
      await o.remarques.oublier(projet);
      await Promise.all([
        rm(depotRelecture(o.dossiers, projet), { recursive: true, force: true }),
        rm(fichierCommentaires(o.dossiers, projet), { force: true }),
      ]);
    },
    arreter: async () => {
      await serveur?.arreter();
    },
  };
}
