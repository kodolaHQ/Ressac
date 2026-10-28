import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CheminsEspace } from "../chemins.js";
import { ecrireEtatBloc, lireAccueilBlocs } from "../accueil/blocs-anciens.js";
import type { EtatBloc } from "../accueil/blocs-anciens.js";
import type { Atelier } from "../conteneur/atelier.js";
import { CODE_DELAI_DEPASSE, type Executeur } from "../conteneur/executeur.js";
import { construireCommande, type Profil } from "../profils/profil.js";
import { blocsAEchoir, consigneVeille } from "./echeances.js";

const LONGUEUR_ERREUR = 500;
/** Marge du délai local au-delà du `timeout` lancé dans le conteneur. */
const MARGE_MS = 30_000;
const ATTENTE_ARRET_MS = 15_000;

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
  private enCours: Promise<string[]> | null = null;
  /** Bloc dont la veille tourne en ce moment. */
  private veille: string | null = null;
  private arrete = false;

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
    if (this.enCours || this.arrete) return [];
    this.enCours = this.verifierMaintenant(o).finally(() => (this.enCours = null));
    return this.enCours;
  }

  private async verifierMaintenant(o: { auLancement: boolean }): Promise<string[]> {
    if ((await this.o.atelier.etat()) !== "demarre") return [];
    const { blocs } = await lireAccueilBlocs(this.o.chemins);
    const ids = blocsAEchoir(blocs, this.o.horloge(), o);
    for (const id of ids) {
      if (this.arrete) break;
      const bloc = blocs.find((b) => b.id === id);
      if (!bloc || !("config" in bloc) || bloc.config.type !== "agent") continue;
      this.veille = id;
      try {
        await this.rafraichir(id, bloc.etat, bloc.config);
      } finally {
        this.veille = null;
      }
    }
    return ids;
  }

  private async rafraichir(id: string, ancien: EtatBloc, config: Parameters<typeof consigneVeille>[1]): Promise<void> {
    const debut = this.o.horloge().toISOString();
    await ecrireEtatBloc(this.o.chemins, id, { derniereMaj: ancien.derniereMaj, derniereTentative: debut, statut: "en-cours" });
    // L'agent écrit un brouillon ; il ne remplace index.html qu'en cas de succès.
    const brouillon = join(this.o.chemins.blocs, id, "index.html.nouveau");
    await rm(brouillon, { force: true });
    const consigne = consigneVeille(id, config);
    const [cmd, ...args] = this.o.atelier.commandeVeille(
      id,
      construireCommande(this.o.profil, "nonInteractif", { consigne }),
      Math.round(this.o.delaiMs / 1000),
    );
    const r = await this.o.executer(cmd!, args, { delaiMs: this.o.delaiMs + MARGE_MS });
    // Arrêt du noyau (sortie, changement de profil) : la veille n'a pas échoué, elle reprendra plus tard.
    if (this.arrete) {
      await rm(brouillon, { force: true });
      await ecrireEtatBloc(this.o.chemins, id, ancien);
      return;
    }
    const echec = (erreur: string): EtatBloc => ({
      derniereMaj: ancien.derniereMaj,
      derniereTentative: debut,
      statut: "erreur",
      erreur: erreur.slice(0, LONGUEUR_ERREUR),
    });
    let etat: EtatBloc;
    if (r.code === CODE_DELAI_DEPASSE) {
      await this.o.atelier.supprimerVeille(id);
      etat = echec("Délai dépassé");
    } else if (r.code !== 0) {
      etat = echec(r.stderr.trim() || r.stdout.trim() || `Code de sortie ${r.code}`);
    } else if (!existsSync(brouillon)) {
      etat = echec("Aucun résultat écrit par l'agent");
    } else {
      await rename(brouillon, join(this.o.chemins.blocs, id, "index.html"));
      etat = { derniereMaj: this.o.horloge().toISOString(), derniereTentative: debut, statut: "ok" };
    }
    await rm(brouillon, { force: true });
    await ecrireEtatBloc(this.o.chemins, id, etat);
  }

  /** Coupe la minuterie ; une veille en cours est tuée dans son conteneur et attendue (le prochain noyau ne la croisera pas). */
  async arreter(): Promise<void> {
    clearInterval(this.minuterie);
    this.arrete = true;
    if (this.veille) await this.o.atelier.supprimerVeille(this.veille).catch(() => {});
    // Borné : quitter le navigateur ne doit pas attendre une veille qui aurait échappé à l'arrêt.
    let minuterie: NodeJS.Timeout | undefined;
    await Promise.race([this.enCours?.catch(() => {}), new Promise((ok) => (minuterie = setTimeout(ok, ATTENTE_ARRET_MS)))]);
    clearTimeout(minuterie);
  }
}
