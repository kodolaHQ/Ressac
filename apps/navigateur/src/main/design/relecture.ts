import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CommentairesRelecture,
  DepotRelecture,
  depotRelecture,
  ErreurRelecture,
  fichierCommentaires,
  ID_PROJET,
  type CheminsEspace,
  type Comparaison,
  type DiffFichier,
  type DossiersDesign,
  type IdProjet,
  type RegistreExternes,
} from "@webaios/noyau";
import type { VueRelecture } from "../../commun/api";

/** Raison affichée pour un projet que la relecture ne connaît pas (démo, projet externe oublié, dossier disparu). */
export const PROJET_INCONNU = "projet inconnu";
/** Lignes rendues au plus par un appel à `lignes` (la page en demande 20 à la fois). */
export const LIGNES_MAX = 200;

/**
 * La relecture des projets : la photo de prise en charge de chaque appli de l'agent, la comparaison avec la dernière
 * relecture (gardée en mémoire par projet : le diff ne bouge pas avant « Rafraîchir »), le diff d'un fichier et ses lignes
 * cachées. Un chemin n'est jamais libre : il doit être dans la comparaison gardée.
 */
export class ServiceRelecture {
  private readonly comparaisons = new Map<IdProjet, { depot: DepotRelecture; comparaison: Comparaison }>();
  private priseEnCours: Promise<void> = Promise.resolve();

  constructor(
    private readonly o: {
      dossiers: DossiersDesign;
      chemins: CheminsEspace;
      registre: () => RegistreExternes | null;
      git?: string;
      /** Les noms des applis de l'agent (leur fiche) ; le nom de dossier sinon. */
      applis?: () => Promise<{ dossier: string; nom: string }[]>;
    },
  ) {}

  private depot(p: IdProjet, dossier: string): DepotRelecture {
    return new DepotRelecture({ depot: depotRelecture(this.o.dossiers, p), dossier, ...(this.o.git ? { git: this.o.git } : {}) });
  }

  /** La première photo de chaque appli (une seule fois par appli), une à la fois, en tâche de fond. */
  priseEnCharge(dossiers: string[]): Promise<void> {
    const suite = this.priseEnCours.then(async () => {
      for (const d of dossiers) {
        const p = `app-${d}`;
        if (!ID_PROJET.test(p)) continue;
        try {
          await this.depot(p, join(this.o.chemins.projets, d)).assurerReference();
        } catch (e) {
          // git absent, dossier illisible ou disparu : la page le dira à l'ouverture.
          if (!(e instanceof ErreurRelecture)) console.error(`[relecture] prise en charge de ${d} :`, e);
        }
      }
    });
    this.priseEnCours = suite.catch(() => undefined);
    return suite;
  }

  /** Le nom et le dossier d'un projet relisible ; null pour une démo, un projet externe oublié ou un dossier absent. */
  async projet(p: IdProjet): Promise<{ nom: string; dossier: string } | null> {
    if (!ID_PROJET.test(p)) return null;
    if (p.startsWith("app-")) {
      const d = p.slice(4);
      const dossier = join(this.o.chemins.projets, d);
      try {
        if (!(await stat(dossier)).isDirectory()) return null;
      } catch {
        return null;
      }
      const nom = (await this.o.applis?.().catch(() => []))?.find((a) => a.dossier === d)?.nom ?? d;
      return { nom, dossier };
    }
    if (p.startsWith("ext-")) {
      const e = this.o.registre()?.projets().find((x) => `ext-${x.id}` === p);
      return e ? { nom: e.nom, dossier: e.dossier } : null;
    }
    return null;
  }

  async ouvrir(p: IdProjet): Promise<VueRelecture> {
    const projet = await this.projet(p);
    if (!projet) {
      this.comparaisons.delete(p);
      return { etat: "indisponible", nom: p, raison: PROJET_INCONNU };
    }
    const depot = this.depot(p, projet.dossier);
    try {
      const comparaison = await depot.comparer();
      this.comparaisons.set(p, { depot, comparaison });
      const commentaires = await new CommentairesRelecture(fichierCommentaires(this.o.dossiers, p)).liste();
      return { etat: "ok", nom: projet.nom, comparaison: { fichiers: comparaison.fichiers }, commentaires };
    } catch (e) {
      this.comparaisons.delete(p);
      if (e instanceof ErreurRelecture) return { etat: "indisponible", nom: projet.nom, raison: e.raison };
      console.error(`[relecture] comparaison de ${p} :`, e);
      return { etat: "indisponible", nom: projet.nom, raison: "la comparaison a échoué" };
    }
  }

  private garde(p: IdProjet, chemin: string) {
    const g = this.comparaisons.get(p);
    const f = g?.comparaison.fichiers.find((x) => x.chemin === chemin);
    if (!g || !f) throw new Error("fichier absent de la relecture");
    return { ...g, fichier: f };
  }

  fichier(p: IdProjet, chemin: string): Promise<DiffFichier> {
    const g = this.garde(p, chemin);
    return g.depot.fichier(g.comparaison, chemin);
  }

  /** Lignes de la version courante (jamais d'un fichier supprimé ni non affichable). */
  async lignes(p: IdProjet, chemin: string, debut: number, fin: number): Promise<string[]> {
    const g = this.garde(p, chemin);
    if (g.fichier.statut === "supprime" || g.fichier.affichable !== true) return [];
    const a = Math.max(1, Math.floor(debut));
    const b = Math.min(Math.floor(fin), a + LIGNES_MAX - 1);
    if (b < a) return [];
    // Une ligne de plus : si elle manque, la fin du fichier est atteinte et son dernier « \n » ne fait pas une ligne vide.
    const l = await g.depot.lignes(g.comparaison.arbreCourant, chemin, a, b + 1);
    if (l.length > b - a + 1) return l.slice(0, b - a + 1);
    return l.at(-1) === "" ? l.slice(0, -1) : l;
  }

  /** Un projet oublié : sa comparaison gardée tombe. */
  oublier(p: IdProjet): void {
    this.comparaisons.delete(p);
  }
}
