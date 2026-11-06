// Copy of Electron's main/design/relecture.ts, body unchanged apart from the import paths, the class name and the
// comments translated (test/review-host.test.ts compares behaviour): Node cannot load that file under tsx (its
// "../../commun/modele" value import has no extension), so the host imports this one.
import { lstat, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  CommentairesRelecture,
  DepotRelecture,
  depotRelecture,
  destinationDe,
  ErreurRelecture,
  fichierCommentaires,
  ID_PROJET,
  ID_SITE,
  projetPourSite,
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
} from "../../../packages/noyau/src/index.ts";
import type { ResultatExtension, VueRelecture } from "../../navigateur/src/commun/api.ts";
import { PLAGE_HORS_BLOC } from "../../navigateur/src/commun/modele.ts";

/** Reason shown for a project the review does not know (demo, forgotten external project, vanished folder). */
export const PROJET_INCONNU = "projet inconnu";
/** Most lines one `lignes` call returns (the page asks for 20 at a time). */
export const LIGNES_MAX = 200;
/** Most comparisons kept per project (a page may show a comparison older than the latest). */
export const COMPARAISONS_GARDEES = 8;
/** A page asks for a comparison that is no longer kept (or never made). */
export const COMPARAISON_INCONNUE = "Cette comparaison n'est plus gardée : Rafraîchis la relecture.";
/** A comparison's token: its two trees (reviewed, current). */
export const JETON_RELECTURE = /^[0-9a-f]{40}:[0-9a-f]{40}$/;
const jetonDe = (c: Comparaison) => `${c.arbreRelu}:${c.arbreCourant}`;
export { PLAGE_HORS_BLOC };
/** "Send" with no unresolved comment. */
export const AUCUN_COMMENTAIRE = "Aucun commentaire à envoyer.";

/**
 * A comment's lines, read from the kept diff: those of a single block whose position (new number, that of the next
 * line for a removal) runs from `debut` to `fin`, every position present. null if no block fits.
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
 * The review of projects: the takeover snapshot of each agent app, the comparison with the last review, a file's diff
 * and its hidden lines. Each comparison has its token (its two trees); the last `COMPARAISONS_GARDEES` of each project
 * are kept, so each page stays on the one it shows until "Rafraîchir". A path is never free: it must be in the
 * token's comparison.
 */
export class ReviewService {
  /** Per project, the kept comparisons, the most recent first. */
  private readonly comparaisons = new Map<IdProjet, { jeton: string; depot: DepotRelecture; comparaison: Comparaison }[]>();
  private priseEnCours: Promise<void> = Promise.resolve();
  /** Each project's comments (one instance per project). */
  private readonly listes = new Map<IdProjet, CommentairesRelecture>();

  constructor(
    private readonly o: {
      dossiers: DossiersDesign;
      chemins: CheminsEspace;
      registre: () => RegistreExternes | null;
      git?: string;
      /** The agent apps' names (their card); the folder name otherwise. */
      applis?: () => Promise<{ dossier: string; nom: string }[]>;
      /** The site apps' names (their site.json); their id otherwise. */
      sites?: () => Promise<{ id: string; nom: string }[]>;
      /** The batches of sent comments. */
      remarques: Remarques;
      /** After a batch is written (as in design mode: pre-fill the agent's session; nothing for an external project). */
      envoyer(p: ProjetSuivi, lot: Lot): Promise<void>;
    },
  ) {}

  private depot(p: IdProjet, dossier: string): DepotRelecture {
    return new DepotRelecture({ depot: depotRelecture(this.o.dossiers, p), dossier, ...(this.o.git ? { git: this.o.git } : {}) });
  }

  /**
   * An agent app's folder, if it is a real folder under the projects folder: never a symlink (the container writes
   * into ~/WebAiOs/projets and could plant a link to the home folder there).
   */
  private async dossierApp(d: string): Promise<string | null> {
    const dossier = join(this.o.chemins.projets, d);
    try {
      if (!(await lstat(dossier)).isDirectory()) return null;
      const [reel, base] = await Promise.all([realpath(dossier), realpath(this.o.chemins.projets)]);
      return reel.startsWith(base + sep) ? dossier : null;
    } catch {
      return null;
    }
  }

  /**
   * A site app's folder (`~/WebAiOs/sites/<id>`), if it is a real folder under the sites folder: never a symlink
   * (the agent writes into ~/WebAiOs/sites and could plant a link to the home folder there).
   */
  private async dossierSite(id: string): Promise<string | null> {
    if (!ID_SITE.test(id)) return null;
    const dossier = join(this.o.chemins.sites, id);
    try {
      if (!(await lstat(dossier)).isDirectory()) return null;
      const [reel, base] = await Promise.all([realpath(dossier), realpath(this.o.chemins.sites)]);
      return reel.startsWith(base + sep) ? dossier : null;
    } catch {
      return null;
    }
  }

  /** One task of the snapshot queue (takeovers, `assurer`, `effacer`): one at a time, in order. */
  private enFile(f: () => Promise<void>): Promise<void> {
    const suite = this.priseEnCours.then(f);
    this.priseEnCours = suite.catch(() => undefined);
    return suite;
  }

  /** A project's first snapshot in its folder, if missing; an error is swallowed (the page will say it). */
  private async photo(p: IdProjet, dossier: string | null): Promise<void> {
    if (!dossier) return;
    try {
      await this.depot(p, dossier).assurerReference();
    } catch (e) {
      // git missing, folder unreadable or gone: the page will say so when opened.
      if (!(e instanceof ErreurRelecture)) console.error(`[relecture] prise en charge de ${p} :`, e);
    }
  }

  /** The first snapshot of each app (once per app), one at a time, in the background. */
  priseEnCharge(dossiers: string[]): Promise<void> {
    return this.enFile(async () => {
      for (const d of dossiers) {
        const p = `app-${d}`;
        if (!ID_PROJET.test(p)) continue;
        await this.photo(p, await this.dossierApp(d));
      }
    });
  }

  /** The first snapshot of each site app, through the same queue; an id outside `ID_SITE` is ignored. */
  priseEnChargeSites(ids: string[]): Promise<void> {
    return this.enFile(async () => {
      for (const id of ids) {
        if (!ID_SITE.test(id)) continue;
        await this.photo(`site-${id}`, await this.dossierSite(id));
      }
    });
  }

  /** A site app's first snapshot if missing (before a batch is sent), through the same queue; no effect otherwise. */
  assurer(p: IdProjet): Promise<void> {
    if (!ID_PROJET.test(p) || !p.startsWith("site-")) return Promise.resolve();
    const id = p.slice(5);
    return this.enFile(async () => this.photo(p, await this.dossierSite(id)));
  }

  /**
   * A deleted site app: its comparisons and comments forgotten, its review repository and comments file erased. After
   * the queued snapshots (which would otherwise recreate the repository), and through the repository's queue.
   */
  effacer(p: IdProjet): Promise<void> {
    if (!ID_PROJET.test(p)) return Promise.resolve();
    this.oublier(p);
    return this.enFile(async () => {
      this.oublier(p);
      await Promise.all([
        new DepotRelecture({ depot: depotRelecture(this.o.dossiers, p), dossier: this.o.chemins.sites, ...(this.o.git ? { git: this.o.git } : {}) }).supprimer(),
        rm(fichierCommentaires(this.o.dossiers, p), { force: true }),
      ]);
    });
  }

  /** The name and folder of a reviewable project; null for a demo, a forgotten external project or a missing folder. */
  async projet(p: IdProjet): Promise<{ nom: string; dossier: string } | null> {
    if (!ID_PROJET.test(p)) return null;
    if (p.startsWith("app-")) {
      const d = p.slice(4);
      const dossier = await this.dossierApp(d);
      if (!dossier) return null;
      const nom = (await this.o.applis?.().catch(() => []))?.find((a) => a.dossier === d)?.nom ?? d;
      return { nom, dossier };
    }
    if (p.startsWith("ext-")) {
      const e = this.o.registre()?.projets().find((x) => `ext-${x.id}` === p);
      return e ? { nom: e.nom, dossier: e.dossier } : null;
    }
    if (p.startsWith("site-")) {
      const id = p.slice(5);
      const dossier = await this.dossierSite(id);
      if (!dossier) return null;
      const nom = (await this.o.sites?.().catch(() => []))?.find((s) => s.id === id)?.nom ?? id;
      return { nom, dossier };
    }
    return null;
  }

  /**
   * With the token of a kept comparison: that one, without comparing again (a remounted page shows the same thing).
   * Without a token (or if it is no longer kept): a new comparison, kept at the head.
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

  /** The comparison of a kept token ("Marquer comme relu" keeps the tree the page showed). */
  comparaison(p: IdProjet, jeton: string): { depot: DepotRelecture; comparaison: Comparaison } | null {
    return this.comparaisons.get(p)?.find((x) => x.jeton === jeton) ?? null;
  }

  async fichier(p: IdProjet, jeton: string, chemin: string): Promise<DiffFichier> {
    const g = this.garde(p, jeton, chemin);
    const diff = await g.depot.fichier(g.comparaison, chemin);
    // Not displayable: its comments stay as they are.
    if (diff.affichable === true) await this.commentairesDe(p).recollerFichier(chemin, diff);
    return diff;
  }

  /** Lines of the current version (never of a deleted or non-displayable file). */
  async lignes(p: IdProjet, jeton: string, chemin: string, debut: number, fin: number): Promise<string[]> {
    const g = this.garde(p, jeton, chemin);
    if (g.fichier.statut === "supprime" || g.fichier.affichable !== true) return [];
    const a = Math.max(1, Math.floor(debut));
    const b = Math.min(Math.floor(fin), a + LIGNES_MAX - 1);
    if (b < a) return [];
    // One more line: if it is missing, the end of the file is reached and its last "\n" does not make an empty line.
    const l = await g.depot.lignes(g.comparaison.arbreCourant, chemin, a, b + 1);
    if (l.length > b - a + 1) return l.slice(0, b - a + 1);
    return l.at(-1) === "" ? l.slice(0, -1) : l;
  }

  /** A single instance per project: its write queue serialises every change to its comments. */
  private commentairesDe(p: IdProjet): CommentairesRelecture {
    let c = this.listes.get(p);
    if (!c) {
      c = new CommentairesRelecture(fichierCommentaires(this.o.dossiers, p));
      this.listes.set(p, c);
    }
    return c;
  }

  /**
   * The comments re-anchored to the shown comparison's diff. Those of a file absent from the comparison (reviewed,
   * unchanged since) or not displayable stay as they are: nothing says their lines changed.
   */
  private async recollerTout(p: IdProjet, g: { depot: DepotRelecture; comparaison: Comparaison }): Promise<Commentaire[]> {
    const commentaires = this.commentairesDe(p);
    const fichiers = new Set((await commentaires.liste()).map((c) => c.fichier));
    for (const chemin of fichiers) {
      const f = g.comparaison.fichiers.find((x) => x.chemin === chemin);
      if (!f || f.affichable !== true) continue;
      const diff = await g.depot.fichier(g.comparaison, chemin).catch(() => null);
      if (diff && diff.affichable === true) await commentaires.recollerFichier(chemin, diff);
    }
    return commentaires.liste();
  }

  /** The followed project (destination of the send); null for an unknown project. */
  private async suivi(p: IdProjet): Promise<ProjetSuivi | null> {
    const projet = await this.projet(p);
    if (!projet) return null;
    if (p.startsWith("app-")) return { type: "app", projet: p, dossier: p.slice(4), nom: projet.nom };
    if (p.startsWith("site-")) return projetPourSite(p.slice(5), projet.nom);
    const e = this.o.registre()?.projets().find((x) => `ext-${x.id}` === p);
    return e ? { type: "externe", projet: p, dossier: e.dossier, nom: e.nom, client: e.client } : null;
  }

  private destination(s: ProjetSuivi | null): { destination: string | null; sansDestination: string | null } {
    if (!s) return { destination: null, sansDestination: PROJET_INCONNU };
    const d = destinationDe(s, this.o.registre()?.clients() ?? []);
    return "libelle" in d ? { destination: d.libelle, sansDestination: null } : { destination: null, sansDestination: d.indisponible };
  }

  /** The project's comments, as stored (without re-anchoring). */
  commentaires(p: IdProjet): Promise<Commentaire[]> {
    return this.commentairesDe(p).liste();
  }

  /** A comment on lines `debut`..`fin` of a file of the token's comparison, read here from the kept diff. */
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

  /** The unresolved comments (already-sent ones included) become a batch for the agent or the connected Claude Code. */
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
      // A comment edited during the send stays "not sent": its new text did not go.
      await commentaires.marquerEnvoyesSiInchanges(a.map((c) => ({ id: c.id, texte: c.texte })));
      await this.o.envoyer(s, lot);
      return { ok: true };
    } catch (e) {
      return { ok: false, erreur: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * "Marquer comme relu": keeps the tree the page showed (the token's), never a new state: what changed since stays to
   * review. Resolved comments go; the project's kept comparisons drop (another page can no longer keep an older tree);
   * then a new comparison.
   */
  async relu(p: IdProjet, jeton: string): Promise<VueRelecture> {
    const g = this.comparaison(p, jeton);
    if (!g) throw new Error(COMPARAISON_INCONNUE);
    await g.depot.retenir(g.comparaison.arbreCourant);
    await this.commentairesDe(p).apresRelu();
    this.comparaisons.delete(p);
    return this.ouvrir(p);
  }

  /** A forgotten project: its kept comparisons drop. */
  oublier(p: IdProjet): void {
    this.comparaisons.delete(p);
    this.listes.delete(p);
  }
}
