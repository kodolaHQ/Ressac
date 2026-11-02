import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CommentairesRelecture,
  DepotRelecture,
  depotRelecture,
  destinationDe,
  ErreurRelecture,
  fichierCommentaires,
  ID_PROJET,
  positionNouvelle,
  REMARQUE_VIDE,
  SANS_CLIENT,
  type CheminsEspace,
  type Commentaire,
  type Comparaison,
  type DiffFichier,
  type DossiersDesign,
  type IdProjet,
  type Lot,
  type ProjetSuivi,
  type RegistreExternes,
  type Remarques,
} from "@webaios/noyau";
import type { ResultatExtension, VueRelecture } from "../../commun/api";
import { PLAGE_HORS_BLOC } from "../../commun/modele";

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
export { PLAGE_HORS_BLOC };
/** « Envoyer » sans commentaire non résolu. */
export const AUCUN_COMMENTAIRE = "Aucun commentaire à envoyer.";

/**
 * Les lignes d'un commentaire, lues dans le diff gardé : celles d'un même bloc dont la position (numéro nouveau, celui
 * de la ligne suivante pour un retrait) va de `debut` à `fin`, chaque position présente. null si aucun bloc ne convient.
 */
export function lignesDuBloc(diff: DiffFichier, debut: number, fin: number): Commentaire["lignes"] | null {
  if (!Number.isSafeInteger(debut) || !Number.isSafeInteger(fin) || debut < 1 || fin < debut) return null;
  for (const b of diff.blocs) {
    const lignes = b.lignes.map((l, i) => ({ marque: l.marque, texte: l.texte, position: positionNouvelle(b, i) }));
    const dedans = lignes.filter((l) => l.position >= debut && l.position <= fin);
    const positions = new Set(dedans.map((l) => l.position));
    let complet = true;
    for (let n = debut; n <= fin && complet; n++) complet = positions.has(n);
    if (complet) return dedans.map(({ marque, texte }) => ({ marque, texte }));
  }
  return null;
}

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
      /** Les lots des commentaires envoyés. */
      remarques: Remarques;
      /** Après l'écriture d'un lot (comme le mode design : pré-remplir la session de l'agent ; rien pour un projet externe). */
      envoyer(p: ProjetSuivi, lot: Lot): Promise<void>;
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
      const commentaires = await this.recollerTout(p, g);
      return {
        etat: "ok", nom: projet.nom, jeton: g.jeton, comparaison: { fichiers: g.comparaison.fichiers }, commentaires,
        ...this.destination(await this.suivi(p)),
      };
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
    const diff = await g.depot.fichier(g.comparaison, chemin);
    await this.commentairesDe(p).recollerFichier(chemin, diff.affichable === true ? diff : null);
    return diff;
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

  private commentairesDe(p: IdProjet): CommentairesRelecture {
    return new CommentairesRelecture(fichierCommentaires(this.o.dossiers, p));
  }

  /** Les commentaires recollés au diff de la comparaison montrée ; ceux d'un fichier qui n'y est plus, « ligne changée ». */
  private async recollerTout(p: IdProjet, g: { depot: DepotRelecture; comparaison: Comparaison }): Promise<Commentaire[]> {
    const commentaires = this.commentairesDe(p);
    const fichiers = new Set((await commentaires.liste()).map((c) => c.fichier));
    for (const chemin of fichiers) {
      const f = g.comparaison.fichiers.find((x) => x.chemin === chemin);
      const diff = f && f.affichable === true ? await g.depot.fichier(g.comparaison, chemin).catch(() => null) : null;
      await commentaires.recollerFichier(chemin, diff);
    }
    return commentaires.liste();
  }

  /** Le projet suivi (destination de l'envoi) ; null pour un projet inconnu. */
  private async suivi(p: IdProjet): Promise<ProjetSuivi | null> {
    const projet = await this.projet(p);
    if (!projet) return null;
    if (p.startsWith("app-")) return { type: "app", projet: p, dossier: p.slice(4), nom: projet.nom };
    const e = this.o.registre()?.projets().find((x) => `ext-${x.id}` === p);
    return e ? { type: "externe", projet: p, dossier: e.dossier, nom: e.nom, client: e.client } : null;
  }

  private destination(s: ProjetSuivi | null): { destination: string | null; sansDestination: string | null } {
    if (!s) return { destination: null, sansDestination: PROJET_INCONNU };
    const d = destinationDe(s, this.o.registre()?.clients() ?? []);
    return "libelle" in d ? { destination: d.libelle, sansDestination: null } : { destination: null, sansDestination: d.indisponible };
  }

  /** Les commentaires du projet, tels qu'enregistrés (sans recoller). */
  commentaires(p: IdProjet): Promise<Commentaire[]> {
    return this.commentairesDe(p).liste();
  }

  /** Un commentaire sur les lignes `debut`..`fin` d'un fichier de la comparaison du jeton, lues ici dans le diff gardé. */
  async commenter(p: IdProjet, jeton: string, c: { fichier: string; debut: number; fin: number; texte: string }): Promise<ResultatExtension> {
    try {
      if (c.texte.trim() === "") return { ok: false, erreur: REMARQUE_VIDE };
      const g = this.garde(p, jeton, c.fichier);
      const diff = await g.depot.fichier(g.comparaison, c.fichier);
      const lignes = diff.affichable === true ? lignesDuBloc(diff, c.debut, c.fin) : null;
      if (!lignes) return { ok: false, erreur: PLAGE_HORS_BLOC };
      await this.commentairesDe(p).ajouter({ fichier: c.fichier, debut: c.debut, fin: c.fin, lignes, texte: c.texte });
      return { ok: true };
    } catch (e) {
      return { ok: false, erreur: e instanceof Error ? e.message : String(e) };
    }
  }

  modifierCommentaire(p: IdProjet, id: string, texte: string): Promise<void> {
    return this.commentairesDe(p).modifier(id, texte);
  }

  resoudre(p: IdProjet, id: string, resolu: boolean): Promise<void> {
    return this.commentairesDe(p).resoudre(id, resolu);
  }

  supprimerCommentaire(p: IdProjet, id: string): Promise<void> {
    return this.commentairesDe(p).supprimer(id);
  }

  /** Les commentaires non résolus (déjà envoyés compris) deviennent un lot pour l'agent ou le Claude Code branché. */
  async envoyer(p: IdProjet): Promise<ResultatExtension> {
    try {
      const s = await this.suivi(p);
      if (!s) return { ok: false, erreur: PROJET_INCONNU };
      let destination: { destination: "agent" | "mcp"; client?: string } = { destination: "agent" };
      if (s.type === "externe") {
        const d = destinationDe(s, this.o.registre()?.clients() ?? []);
        if ("indisponible" in d || s.client === null) return { ok: false, erreur: SANS_CLIENT };
        destination = { destination: "mcp", client: s.client };
      }
      const commentaires = this.commentairesDe(p);
      const a = await commentaires.aEnvoyer();
      if (a.length === 0) return { ok: false, erreur: AUCUN_COMMENTAIRE };
      const lot = await this.o.remarques.envoyerRelecture(
        p,
        a.map((c) => ({ texte: c.texte, contexte: { fichier: c.fichier, debut: c.debut, fin: c.fin, lignes: c.lignes } })),
        destination,
      );
      await commentaires.marquerEnvoyes(a.map((c) => c.id));
      await this.o.envoyer(s, lot);
      return { ok: true };
    } catch (e) {
      return { ok: false, erreur: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * « Marquer comme relu » : retient l'arbre que la page a montré (celui du jeton), jamais un nouvel état : ce qui a
   * changé depuis reste à relire. Les commentaires résolus partent ; les comparaisons gardées du projet tombent (une
   * autre page ne peut plus retenir un arbre plus ancien) ; puis une nouvelle comparaison.
   */
  async relu(p: IdProjet, jeton: string): Promise<VueRelecture> {
    const g = this.comparaison(p, jeton);
    if (!g) throw new Error(COMPARAISON_INCONNUE);
    await g.depot.retenir(g.comparaison.arbreCourant);
    await this.commentairesDe(p).apresRelu();
    this.comparaisons.delete(p);
    return this.ouvrir(p);
  }

  /** Un projet oublié : ses comparaisons gardées tombent. */
  oublier(p: IdProjet): void {
    this.comparaisons.delete(p);
  }
}
