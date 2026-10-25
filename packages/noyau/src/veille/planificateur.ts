import type { CheminsEspace } from "../chemins.js";
import { ecrireEtatBloc, lireAccueil } from "../accueil/lire.js";
import type { EtatBloc } from "../accueil/schemas.js";
import type { Atelier } from "../conteneur/atelier.js";
import { CODE_DELAI_DEPASSE, type Executeur } from "../conteneur/executeur.js";
import { construireCommande, type Profil } from "../profils/profil.js";
import { blocsAEchoir, consigneVeille } from "./echeances.js";

const LONGUEUR_ERREUR = 500;

/** Rafraîchit les blocs d'agent en lançant l'agent en mode non interactif, sans accès au navigateur. */
export class PlanificateurVeille {
  private readonly o: {
    chemins: CheminsEspace;
    atelier: Atelier;
    profil: Profil;
    executer: Executeur;
    horloge: () => Date;
    intervalleMs: number;
    delaiMs: number;
  };
  private minuterie: NodeJS.Timeout | undefined;
  private enCours = false;

  constructor(o: {
    chemins: CheminsEspace;
    atelier: Atelier;
    profil: Profil;
    executer: Executeur;
    horloge?: () => Date;
    intervalleMs?: number;
    delaiMs?: number;
  }) {
    // `??` plutôt qu'un spread : une option passée explicitement à undefined garde sa valeur par défaut.
    this.o = {
      ...o,
      horloge: o.horloge ?? (() => new Date()),
      intervalleMs: o.intervalleMs ?? 15 * 60_000,
      delaiMs: o.delaiMs ?? 10 * 60_000,
    };
  }

  /** Vérifie au lancement en arrière-plan (une veille prend des minutes), puis à intervalle régulier. */
  async demarrer(): Promise<void> {
    this.enFond({ auLancement: true });
    this.minuterie = setInterval(() => this.enFond({ auLancement: false }), this.o.intervalleMs);
  }

  /** Une erreur de fond ne doit jamais faire tomber le navigateur. */
  private enFond(o: { auLancement: boolean }): void {
    this.verifier(o).catch((e) => console.error("[webaios] veille :", e));
  }

  async verifier(o: { auLancement: boolean }): Promise<string[]> {
    if (this.enCours) return [];
    this.enCours = true;
    try {
      if ((await this.o.atelier.etat()) !== "demarre") return [];
      const { blocs } = await lireAccueil(this.o.chemins);
      const ids = blocsAEchoir(blocs, this.o.horloge(), o);
      for (const id of ids) {
        const bloc = blocs.find((b) => b.id === id);
        if (bloc && "config" in bloc && bloc.config.type === "agent") await this.rafraichir(id, bloc.etat, bloc.config);
      }
      return ids;
    } finally {
      this.enCours = false;
    }
  }

  private async rafraichir(id: string, ancien: EtatBloc, config: Parameters<typeof consigneVeille>[1]): Promise<void> {
    const debut = this.o.horloge().toISOString();
    await ecrireEtatBloc(this.o.chemins, id, { derniereMaj: ancien.derniereMaj, derniereTentative: debut, statut: "en-cours" });
    const consigne = consigneVeille(id, config);
    const [cmd, ...args] = this.o.atelier.commandeExec(construireCommande(this.o.profil, "nonInteractif", { consigne }), {
      interactif: false,
    });
    const r = await this.o.executer(cmd!, args, { delaiMs: this.o.delaiMs });
    const etat: EtatBloc =
      r.code === 0
        ? { derniereMaj: this.o.horloge().toISOString(), derniereTentative: debut, statut: "ok" }
        : {
            derniereMaj: ancien.derniereMaj,
            derniereTentative: debut,
            statut: "erreur",
            erreur:
              r.code === CODE_DELAI_DEPASSE
                ? "Délai dépassé"
                : (r.stderr.trim() || r.stdout.trim() || `Code de sortie ${r.code}`).slice(0, LONGUEUR_ERREUR),
          };
    await ecrireEtatBloc(this.o.chemins, id, etat);
  }

  arreter(): void {
    clearInterval(this.minuterie);
  }
}
