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
/** Comparaisons gardées au plus par projet (une page peut montrer une comparaison plus ancienne que la dernière). */
export const COMPARAISONS_GARDEES = 8;
/** Une page demande une comparaison qui n'est plus gardée (ou jamais faite). */
export const COMPARAISON_INCONNUE = "Cette comparaison n'est plus gardée : Rafraîchis la relecture.";
/** Le jeton d'une comparaison : ses deux arbres (relu, courant). */
export const JETON_RELECTURE = /^[0-9a-f]{40}:[0-9a-f]{40}$/;
const jetonDe = (c: Comparaison) => `${c.arbreRelu}:${c.arbreCourant}`;

/**
 * La relecture des projets : la photo de prise en charge de chaque appli de l'agent, la comparaison avec la dernière
 * relecture, le diff d'un fichier et ses lignes cachées. Chaque comparaison a son jeton (ses deux arbres) ; les
 * `COMPARAISONS_GARDEES` dernières de chaque projet sont gardées, si bien que chaque page reste sur celle qu'elle montre
 * jusqu'à « Rafraîchir ». Un chemin n'est jamais libre : il doit être dans la comparaison du jeton.
 */
export class ServiceRelecture {
  /** Par projet, les comparaisons gardées, la plus récente en premier. */
  private readonly comparaisons = new Map<IdProjet, { jeton: string; depot: DepotRelecture; comparaison: Comparaison }[]>();
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

  /**
   * Avec le jeton d'une comparaison gardée : celle-là, sans comparer de nouveau (une page remontée montre la même chose).
   * Sans jeton (ou s'il n'est plus gardé) : une nouvelle comparaison, gardée en tête.
   */
  async ouvrir(p: IdProjet, jeton?: string): Promise<VueRelecture> {
    const projet = await this.projet(p);
    if (!projet) {
      this.comparaisons.delete(p);
      return { etat: "indisponible", nom: p, raison: PROJET_INCONNU };
    }
    try {
      let g = jeton ? this.comparaisons.get(p)?.find((x) => x.jeton === jeton) : undefined;
      if (!g) {
        const depot = this.depot(p, projet.dossier);
        const comparaison = await depot.comparer();
        g = { jeton: jetonDe(comparaison), depot, comparaison };
        const autres = (this.comparaisons.get(p) ?? []).filter((x) => x.jeton !== g!.jeton);
        this.comparaisons.set(p, [g, ...autres].slice(0, COMPARAISONS_GARDEES));
      }
      const commentaires = await new CommentairesRelecture(fichierCommentaires(this.o.dossiers, p)).liste();
      return { etat: "ok", nom: projet.nom, jeton: g.jeton, comparaison: { fichiers: g.comparaison.fichiers }, commentaires };
    } catch (e) {
      if (e instanceof ErreurRelecture) return { etat: "indisponible", nom: projet.nom, raison: e.raison };
      console.error(`[relecture] comparaison de ${p} :`, e);
      return { etat: "indisponible", nom: projet.nom, raison: "la comparaison a échoué" };
    }
  }

  private garde(p: IdProjet, jeton: string, chemin: string) {
    const g = this.comparaisons.get(p)?.find((x) => x.jeton === jeton);
    if (!g) throw new Error(COMPARAISON_INCONNUE);
    const f = g.comparaison.fichiers.find((x) => x.chemin === chemin);
    if (!f) throw new Error("fichier absent de la relecture");
    return { ...g, fichier: f };
  }

  /** La comparaison d'un jeton gardé (tâche 12 : « Marquer comme relu » retient l'arbre que la page a montré). */
  comparaison(p: IdProjet, jeton: string): { depot: DepotRelecture; comparaison: Comparaison } | null {
    return this.comparaisons.get(p)?.find((x) => x.jeton === jeton) ?? null;
  }

  async fichier(p: IdProjet, jeton: string, chemin: string): Promise<DiffFichier> {
    const g = this.garde(p, jeton, chemin);
    return g.depot.fichier(g.comparaison, chemin);
  }

  /** Lignes de la version courante (jamais d'un fichier supprimé ni non affichable). */
  async lignes(p: IdProjet, jeton: string, chemin: string, debut: number, fin: number): Promise<string[]> {
    const g = this.garde(p, jeton, chemin);
    if (g.fichier.statut === "supprime" || g.fichier.affichable !== true) return [];
    const a = Math.max(1, Math.floor(debut));
    const b = Math.min(Math.floor(fin), a + LIGNES_MAX - 1);
    if (b < a) return [];
    // Une ligne de plus : si elle manque, la fin du fichier est atteinte et son dernier « \n » ne fait pas une ligne vide.
    const l = await g.depot.lignes(g.comparaison.arbreCourant, chemin, a, b + 1);
    if (l.length > b - a + 1) return l.slice(0, b - a + 1);
    return l.at(-1) === "" ? l.slice(0, -1) : l;
  }

  /** Un projet oublié : ses comparaisons gardées tombent. */
  oublier(p: IdProjet): void {
    this.comparaisons.delete(p);
  }
}
