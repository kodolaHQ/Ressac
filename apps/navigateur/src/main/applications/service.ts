import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";
import { GestionnaireApplications, type Application, type Atelier, type CheminsEspace } from "@webaios/noyau";
import type { ActionApplication, ListeApplications } from "../../commun/api";
import type { Cadre } from "../../commun/modele";
import { FenetresApplications } from "./fenetres";

const FICHIER = "applications.json";

export interface SouvenirApplication {
  cadre?: Cadre;
  dernierLancement?: string;
  favicon?: string;
}

/**
 * Ce que le navigateur retient de chaque appli (`<userData>/applications.json`) : cadre de sa fenêtre, dernier lancement,
 * favicon. Écrit au plus une fois par `delaiMs`, de façon atomique (fichier temporaire + rename).
 */
export class MemoireApplications {
  private donnees: Record<string, SouvenirApplication> = {};
  private minuterie: NodeJS.Timeout | undefined;
  private modifiee = false;
  /** Écritures enchaînées, jamais simultanées. */
  private ecriture: Promise<void> = Promise.resolve();
  private numero = 0;

  constructor(
    private readonly dossier: string,
    private readonly delaiMs = 500,
  ) {
    try {
      const lu: unknown = JSON.parse(readFileSync(join(dossier, FICHIER), "utf8"));
      if (lu && typeof lu === "object" && !Array.isArray(lu)) this.donnees = lu as Record<string, SouvenirApplication>;
    } catch {
      // Absent ou illisible : on repart de zéro (rien d'essentiel n'y est gardé).
    }
  }

  lire(dossier: string): SouvenirApplication {
    return this.donnees[dossier] ?? {};
  }

  noter(dossier: string, s: SouvenirApplication): void {
    this.donnees[dossier] = { ...this.donnees[dossier], ...s };
    this.modifiee = true;
    this.minuterie ??= setTimeout(() => void this.vider(), this.delaiMs);
  }

  /** Écrit ce qui a changé ; attend toujours la fin des écritures en cours (la sortie de l'app en dépend). */
  vider(): Promise<void> {
    clearTimeout(this.minuterie);
    this.minuterie = undefined;
    if (this.modifiee) {
      this.modifiee = false;
      const texte = JSON.stringify(this.donnees, null, 2);
      this.ecriture = this.ecriture.then(() => this.ecrire(texte)).catch((e) => console.error("[applications] mémoire non écrite :", e));
    }
    return this.ecriture;
  }

  private async ecrire(texte: string): Promise<void> {
    const cible = join(this.dossier, FICHIER);
    const temporaire = `${cible}.${process.pid}.${++this.numero}.tmp`;
    await fs.mkdir(this.dossier, { recursive: true });
    await fs.writeFile(temporaire, texte);
    await fs.rename(temporaire, cible);
  }
}

export interface ServiceApplications {
  gestionnaire: GestionnaireApplications;
  fenetres: FenetresApplications;
  memoire: MemoireApplications;
  /** Ce que montre la page Applications. */
  liste(): Promise<ListeApplications>;
  /** Une action de la page Applications ; rejetée en silence si elle ne s'applique pas. */
  agir(dossier: string, action: ActionApplication): void;
  /** À la sortie : arrête les applis en marche, puis écrit la mémoire. */
  arreter(): Promise<void>;
}

/** Plage de ports `min-max` de WEBAIOS_PORTS_APPS (tests), sinon celle du noyau. */
function plageDePorts(valeur: string | undefined): [number, number] | undefined {
  const m = /^(\d+)-(\d+)$/.exec(valeur ?? "");
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/**
 * Gestionnaire des applis de l'espace, partagé par tous les profils d'agent, et leurs fenêtres : une appli en marche a
 * sa fenêtre, une appli arrêtée ou en erreur n'en a pas. Fermer la fenêtre arrête l'appli.
 */
export function demarrerApplications(o: {
  chemins: CheminsEspace;
  atelier: Atelier;
  dossierProfil: string;
  /** Ouvre l'URL dans un onglet de la fenêtre principale active (lien sortant d'une appli). */
  ouvrirOnglet(url: string): void;
  /** La liste ou l'état des applis a changé. */
  diffuser(): void;
  /** Une fenêtre d'appli s'est fermée (par l'utilisateur ou par le programme). */
  surFenetreFermee(dossier: string): void;
}): ServiceApplications {
  const memoire = new MemoireApplications(o.dossierProfil);
  /** Lancements en cours par dossier : une appli relancée passe par « arretee » sans que sa fenêtre doive se fermer. */
  const enCours = new Map<string, number>();
  const delai = Number(process.env.WEBAIOS_DELAI_APP_MS);
  const ports = plageDePorts(process.env.WEBAIOS_PORTS_APPS);

  /** Ferme la fenêtre d'une appli qui n'est plus en marche, sauf pendant un lancement (qui décidera à sa fin). */
  const suivreEtat = (dossier: string) => {
    const etat = gestionnaire.etatDe(dossier);
    if ((etat === "arretee" || etat === "erreur") && !enCours.get(dossier)) fenetres.fermer(dossier);
  };

  // Les lancements viennent de l'agent (outil MCP) comme de la page des applis : tous passent par ici.
  class Gestionnaire extends GestionnaireApplications {
    override lancer(dossier: string): Promise<Application> {
      enCours.set(dossier, (enCours.get(dossier) ?? 0) + 1);
      const fin = super.lancer(dossier);
      void fin
        .then(
          (a) => {
            // Lancée, ou relancée : la fenêtre s'ouvre ou se recharge sur le nouveau port.
            if (a.etat === "en-marche") {
              fenetres.ouvrir(a);
              memoire.noter(dossier, { dernierLancement: new Date().toISOString() });
            }
          },
          () => {},
        )
        .finally(() => {
          const n = (enCours.get(dossier) ?? 1) - 1;
          if (n > 0) enCours.set(dossier, n);
          else enCours.delete(dossier);
          suivreEtat(dossier);
        });
      return fin;
    }
  }

  const gestionnaire: GestionnaireApplications = new Gestionnaire({
    chemins: o.chemins,
    atelier: o.atelier,
    ...(ports ? { ports } : {}),
    ...(delai > 0 ? { delaiPretMs: delai } : {}),
    surChange: () => {
      for (const { dossier } of fenetres.ouvertes()) suivreEtat(dossier);
      o.diffuser();
    },
  });
  const fenetres = new FenetresApplications({
    memoire,
    ouvrirOnglet: o.ouvrirOnglet,
    surFermee: o.surFenetreFermee,
    surFavicon: (dossier, favicon) => {
      if (memoire.lire(dossier).favicon === favicon) return;
      memoire.noter(dossier, { favicon });
      o.diffuser();
    },
    surFermeture: (dossier) => void gestionnaire.arreter(dossier).catch((e) => console.error(`[applications] ${dossier} non arrêtée :`, e)),
  });
  // Une fois par vie du navigateur, en tâche de fond : les fenêtres n'attendent jamais Docker.
  gestionnaire.demarrer().catch((e) => console.error("[applications] démarrage impossible :", e));

  const signaler = (dossier: string, quoi: string) => (e: unknown) => console.error(`[applications] ${dossier} non ${quoi} :`, e);

  return {
    gestionnaire,
    fenetres,
    memoire,
    async liste() {
      const [etat, applications] = await Promise.all([o.atelier.etat(), gestionnaire.liste()]);
      return {
        atelier: etat === "docker-absent" ? "docker-absent" : "ok",
        applications: applications.map((a) => {
          const { favicon, dernierLancement } = memoire.lire(a.dossier);
          return { ...a, ...(favicon ? { favicon } : {}), ...(dernierLancement ? { dernierLancement } : {}) };
        }),
      };
    },
    agir(dossier, action) {
      switch (action) {
        // Relancer = lancer une appli en marche ou en erreur : le gestionnaire arrête d'abord l'instance en cours.
        case "lancer":
        case "relancer":
          void gestionnaire.lancer(dossier).catch(signaler(dossier, "lancée"));
          return;
        case "arreter":
          void gestionnaire.arreter(dossier).catch(signaler(dossier, "arrêtée"));
          return;
        case "ouvrir":
          fenetres.montrer(dossier);
          return;
        default:
        // Déboguer, supprimer, promouvoir, afficher le dossier : à venir.
      }
    },
    async arreter() {
      try {
        await gestionnaire.toutArreter();
        await gestionnaire.arreterSurveillance();
      } finally {
        await memoire.vider();
      }
    },
  };
}
