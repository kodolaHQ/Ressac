// The design review behind the Review page, run by the host.
import { lstat, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  ReviewComments,
  ReviewStore,
  reviewStore,
  destinationOf,
  ReviewError,
  commentsFile,
  PROJECT_ID,
  ID_SITE,
  projectForSite,
  newPosition,
  EMPTY_REMARK,
  NO_CLIENT,
  type SpacePaths,
  type Comment,
  type Comparison,
  type DiffFile,
  type DesignFolders,
  type ProjectId,
  type Batch,
  type TrackedProject,
  type ExternalRegistry,
  type Remarks,
} from "../../../packages/kernel/src/index.ts";
import type { ExtensionResult, ReviewView } from "../shared/api.ts";
import { RANGE_OUTSIDE_BLOCK } from "../shared/model.ts";

/** Reason shown for a project the review does not know (demo, forgotten external project, vanished folder). */
export const UNKNOWN_PROJECT = "projet inconnu";
/** Most lines one `lignes` call returns (the page asks for 20 at a time). */
export const LIGNES_MAX = 200;
/** Most comparisons kept per project (a page may show a comparison older than the latest). */
export const KEPT_COMPARISONS = 8;
/** A page asks for a comparison that is no longer kept (or never made). */
export const UNKNOWN_COMPARISON = "Cette comparaison n'est plus gardée : Rafraîchis la relecture.";
/** A comparison's token: its two trees (reviewed, current). */
export const REVIEW_TOKEN = /^[0-9a-f]{40}:[0-9a-f]{40}$/;
const tokenOf = (c: Comparison) => `${c.arbreRelu}:${c.arbreCourant}`;
export { RANGE_OUTSIDE_BLOCK };
/** "Send" with no unresolved comment. */
export const NO_COMMENT = "Aucun commentaire à envoyer.";

/**
 * A comment's lines, read from the kept diff: those of a single block whose position (new number, that of the next
 * line for a removal) runs from `debut` to `fin`, every position present. null if no block fits.
 */
export function blockLines(diff: DiffFile, start: number, end: number): Comment["lignes"] | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  for (const b of diff.blocs) {
    const lignes = b.lignes.map((l, i) => ({ marque: l.marque, texte: l.texte, position: newPosition(b, i) }));
    const inside = lignes.filter((l) => l.position >= start && l.position <= end);
    const positions = new Set(inside.map((l) => l.position));
    let full = true;
    for (let n = start; n <= end && full; n++) full = positions.has(n);
    if (full) return inside.map(({ marque: mark, texte: text }) => ({ marque: mark, texte: text }));
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
  private readonly comparaisons = new Map<ProjectId, { jeton: string; depot: ReviewStore; comparaison: Comparison }[]>();
  private priseEnCours: Promise<void> = Promise.resolve();
  /** Each project's comments (one instance per project). */
  private readonly listes = new Map<ProjectId, ReviewComments>();

  constructor(
    private readonly o: {
      dossiers: DesignFolders;
      chemins: SpacePaths;
      registre: () => ExternalRegistry | null;
      git?: string;
      /** The agent apps' names (their card); the folder name otherwise. */
      applis?: () => Promise<{ dossier: string; nom: string }[]>;
      /** The site apps' names (their site.json); their id otherwise. */
      sites?: () => Promise<{ id: string; nom: string }[]>;
      /** The batches of sent comments. */
      remarques: Remarks;
      /** After a batch is written (as in design mode: pre-fill the agent's session; nothing for an external project). */
      envoyer(p: TrackedProject, batch: Batch): Promise<void>;
    },
  ) {}

  private depot(p: ProjectId, folder: string): ReviewStore {
    return new ReviewStore({ depot: reviewStore(this.o.dossiers, p), dossier: folder, ...(this.o.git ? { git: this.o.git } : {}) });
  }

  /**
   * An agent app's folder, if it is a real folder under the projects folder: never a symlink (the container writes
   * into ~/WebAiOs/projets and could plant a link to the home folder there).
   */
  private async dossierApp(d: string): Promise<string | null> {
    const folder = join(this.o.chemins.projets, d);
    try {
      if (!(await lstat(folder)).isDirectory()) return null;
      const [real, base] = await Promise.all([realpath(folder), realpath(this.o.chemins.projets)]);
      return real.startsWith(base + sep) ? folder : null;
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
    const folder = join(this.o.chemins.sites, id);
    try {
      if (!(await lstat(folder)).isDirectory()) return null;
      const [real, base] = await Promise.all([realpath(folder), realpath(this.o.chemins.sites)]);
      return real.startsWith(base + sep) ? folder : null;
    } catch {
      return null;
    }
  }

  /** One task of the snapshot queue (takeovers, `assurer`, `effacer`): one at a time, in order. */
  private enFile(f: () => Promise<void>): Promise<void> {
    const next = this.priseEnCours.then(f);
    this.priseEnCours = next.catch(() => undefined);
    return next;
  }

  /** A project's first snapshot in its folder, if missing; an error is swallowed (the page will say it). */
  private async photo(p: ProjectId, folder: string | null): Promise<void> {
    if (!folder) return;
    try {
      await this.depot(p, folder).assurerReference();
    } catch (e) {
      // git missing, folder unreadable or gone: the page will say so when opened.
      if (!(e instanceof ReviewError)) console.error(`[relecture] prise en charge de ${p} :`, e);
    }
  }

  /** The first snapshot of each app (once per app), one at a time, in the background. */
  priseEnCharge(folders: string[]): Promise<void> {
    return this.enFile(async () => {
      for (const d of folders) {
        const p = `app-${d}`;
        if (!PROJECT_ID.test(p)) continue;
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
  assurer(p: ProjectId): Promise<void> {
    if (!PROJECT_ID.test(p) || !p.startsWith("site-")) return Promise.resolve();
    const id = p.slice(5);
    return this.enFile(async () => this.photo(p, await this.dossierSite(id)));
  }

  /**
   * A deleted site app: its comparisons and comments forgotten, its review repository and comments file erased. After
   * the queued snapshots (which would otherwise recreate the repository), and through the repository's queue.
   */
  effacer(p: ProjectId): Promise<void> {
    if (!PROJECT_ID.test(p)) return Promise.resolve();
    this.oublier(p);
    return this.enFile(async () => {
      this.oublier(p);
      await Promise.all([
        new ReviewStore({ depot: reviewStore(this.o.dossiers, p), dossier: this.o.chemins.sites, ...(this.o.git ? { git: this.o.git } : {}) }).supprimer(),
        rm(commentsFile(this.o.dossiers, p), { force: true }),
      ]);
    });
  }

  /** The name and folder of a reviewable project; null for a demo, a forgotten external project or a missing folder. */
  async projet(p: ProjectId): Promise<{ nom: string; dossier: string } | null> {
    if (!PROJECT_ID.test(p)) return null;
    if (p.startsWith("app-")) {
      const d = p.slice(4);
      const folder = await this.dossierApp(d);
      if (!folder) return null;
      const name = (await this.o.applis?.().catch(() => []))?.find((a) => a.dossier === d)?.nom ?? d;
      return { nom: name, dossier: folder };
    }
    if (p.startsWith("ext-")) {
      const e = this.o.registre()?.projets().find((x) => `ext-${x.id}` === p);
      return e ? { nom: e.nom, dossier: e.dossier } : null;
    }
    if (p.startsWith("site-")) {
      const id = p.slice(5);
      const folder = await this.dossierSite(id);
      if (!folder) return null;
      const name = (await this.o.sites?.().catch(() => []))?.find((s) => s.id === id)?.nom ?? id;
      return { nom: name, dossier: folder };
    }
    return null;
  }

  /**
   * With the token of a kept comparison: that one, without comparing again (a remounted page shows the same thing).
   * Without a token (or if it is no longer kept): a new comparison, kept at the head.
   */
  async ouvrir(p: ProjectId, token?: string): Promise<ReviewView> {
    const project = await this.projet(p);
    if (!project) {
      this.comparaisons.delete(p);
      return { etat: "indisponible", nom: p, raison: UNKNOWN_PROJECT };
    }
    try {
      let g = token ? this.comparaisons.get(p)?.find((x) => x.jeton === token) : undefined;
      if (!g) {
        const depot = this.depot(p, project.dossier);
        const comparison = await depot.comparer();
        g = { jeton: tokenOf(comparison), depot, comparaison: comparison };
        const others = (this.comparaisons.get(p) ?? []).filter((x) => x.jeton !== g!.jeton);
        this.comparaisons.set(p, [g, ...others].slice(0, KEPT_COMPARISONS));
      }
      const comments = await this.recollerTout(p, g);
      return {
        etat: "ok", nom: project.nom, jeton: g.jeton, comparaison: { fichiers: g.comparaison.fichiers }, commentaires: comments,
        ...this.destination(await this.suivi(p)),
      };
    } catch (e) {
      if (e instanceof ReviewError) return { etat: "indisponible", nom: project.nom, raison: e.raison };
      console.error(`[relecture] comparaison de ${p} :`, e);
      return { etat: "indisponible", nom: project.nom, raison: "la comparaison a échoué" };
    }
  }

  private garde(p: ProjectId, token: string, path: string) {
    const g = this.comparaisons.get(p)?.find((x) => x.jeton === token);
    if (!g) throw new Error(UNKNOWN_COMPARISON);
    const f = g.comparaison.fichiers.find((x) => x.chemin === path);
    if (!f) throw new Error("fichier absent de la relecture");
    return { ...g, fichier: f };
  }

  /** The comparison of a kept token ("Marquer comme relu" keeps the tree the page showed). */
  comparaison(p: ProjectId, token: string): { depot: ReviewStore; comparaison: Comparison } | null {
    return this.comparaisons.get(p)?.find((x) => x.jeton === token) ?? null;
  }

  async fichier(p: ProjectId, token: string, path: string): Promise<DiffFile> {
    const g = this.garde(p, token, path);
    const diff = await g.depot.fichier(g.comparaison, path);
    // Not displayable: its comments stay as they are.
    if (diff.affichable === true) await this.commentairesDe(p).recollerFichier(path, diff);
    return diff;
  }

  /** Lines of the current version (never of a deleted or non-displayable file). */
  async lignes(p: ProjectId, token: string, path: string, start: number, end: number): Promise<string[]> {
    const g = this.garde(p, token, path);
    if (g.fichier.statut === "supprime" || g.fichier.affichable !== true) return [];
    const a = Math.max(1, Math.floor(start));
    const b = Math.min(Math.floor(end), a + LIGNES_MAX - 1);
    if (b < a) return [];
    // One more line: if it is missing, the end of the file is reached and its last "\n" does not make an empty line.
    const l = await g.depot.lignes(g.comparaison.arbreCourant, path, a, b + 1);
    if (l.length > b - a + 1) return l.slice(0, b - a + 1);
    return l.at(-1) === "" ? l.slice(0, -1) : l;
  }

  /** A single instance per project: its write queue serialises every change to its comments. */
  private commentairesDe(p: ProjectId): ReviewComments {
    let c = this.listes.get(p);
    if (!c) {
      c = new ReviewComments(commentsFile(this.o.dossiers, p));
      this.listes.set(p, c);
    }
    return c;
  }

  /**
   * The comments re-anchored to the shown comparison's diff. Those of a file absent from the comparison (reviewed,
   * unchanged since) or not displayable stay as they are: nothing says their lines changed.
   */
  private async recollerTout(p: ProjectId, g: { depot: ReviewStore; comparaison: Comparison }): Promise<Comment[]> {
    const comments = this.commentairesDe(p);
    const files = new Set((await comments.liste()).map((c) => c.fichier));
    for (const path of files) {
      const f = g.comparaison.fichiers.find((x) => x.chemin === path);
      if (!f || f.affichable !== true) continue;
      const diff = await g.depot.fichier(g.comparaison, path).catch(() => null);
      if (diff && diff.affichable === true) await comments.recollerFichier(path, diff);
    }
    return comments.liste();
  }

  /** The followed project (destination of the send); null for an unknown project. */
  private async suivi(p: ProjectId): Promise<TrackedProject | null> {
    const project = await this.projet(p);
    if (!project) return null;
    if (p.startsWith("app-")) return { type: "app", projet: p, dossier: p.slice(4), nom: project.nom };
    if (p.startsWith("site-")) return projectForSite(p.slice(5), project.nom);
    const e = this.o.registre()?.projets().find((x) => `ext-${x.id}` === p);
    return e ? { type: "externe", projet: p, dossier: e.dossier, nom: e.nom, client: e.client } : null;
  }

  private destination(s: TrackedProject | null): { destination: string | null; sansDestination: string | null } {
    if (!s) return { destination: null, sansDestination: UNKNOWN_PROJECT };
    const d = destinationOf(s, this.o.registre()?.clients() ?? []);
    return "libelle" in d ? { destination: d.libelle, sansDestination: null } : { destination: null, sansDestination: d.indisponible };
  }

  /** The project's comments, as stored (without re-anchoring). */
  commentaires(p: ProjectId): Promise<Comment[]> {
    return this.commentairesDe(p).liste();
  }

  /** A comment on lines `debut`..`fin` of a file of the token's comparison, read here from the kept diff. */
  async commenter(p: ProjectId, token: string, c: { fichier: string; debut: number; fin: number; texte: string }): Promise<ExtensionResult> {
    try {
      if (c.texte.trim() === "") return { ok: false, erreur: EMPTY_REMARK };
      const g = this.garde(p, token, c.fichier);
      const diff = await g.depot.fichier(g.comparaison, c.fichier);
      const lignes = diff.affichable === true ? blockLines(diff, c.debut, c.fin) : null;
      if (!lignes) return { ok: false, erreur: RANGE_OUTSIDE_BLOCK };
      await this.commentairesDe(p).ajouter({ fichier: c.fichier, debut: c.debut, fin: c.fin, lignes, texte: c.texte });
      return { ok: true };
    } catch (e) {
      return { ok: false, erreur: e instanceof Error ? e.message : String(e) };
    }
  }

  modifierCommentaire(p: ProjectId, id: string, text: string): Promise<void> {
    return this.commentairesDe(p).modifier(id, text);
  }

  resoudre(p: ProjectId, id: string, resolved: boolean): Promise<void> {
    return this.commentairesDe(p).resoudre(id, resolved);
  }

  supprimerCommentaire(p: ProjectId, id: string): Promise<void> {
    return this.commentairesDe(p).supprimer(id);
  }

  /** The unresolved comments (already-sent ones included) become a batch for the agent or the connected Claude Code. */
  async envoyer(p: ProjectId): Promise<ExtensionResult> {
    try {
      const s = await this.suivi(p);
      if (!s) return { ok: false, erreur: UNKNOWN_PROJECT };
      let destination: { destination: "agent" | "mcp"; client?: string } = { destination: "agent" };
      if (s.type === "externe") {
        const d = destinationOf(s, this.o.registre()?.clients() ?? []);
        if ("indisponible" in d || s.client === null) return { ok: false, erreur: NO_CLIENT };
        destination = { destination: "mcp", client: s.client };
      }
      const comments = this.commentairesDe(p);
      const a = await comments.aEnvoyer();
      if (a.length === 0) return { ok: false, erreur: NO_COMMENT };
      const batch = await this.o.remarques.envoyerRelecture(
        p,
        a.map((c) => ({ texte: c.texte, contexte: { fichier: c.fichier, debut: c.debut, fin: c.fin, lignes: c.lignes } })),
        destination,
      );
      // A comment edited during the send stays "not sent": its new text did not go.
      await comments.marquerEnvoyesSiInchanges(a.map((c) => ({ id: c.id, texte: c.texte })));
      await this.o.envoyer(s, batch);
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
  async relu(p: ProjectId, token: string): Promise<ReviewView> {
    const g = this.comparaison(p, token);
    if (!g) throw new Error(UNKNOWN_COMPARISON);
    await g.depot.retenir(g.comparaison.arbreCourant);
    await this.commentairesDe(p).apresRelu();
    this.comparaisons.delete(p);
    return this.ouvrir(p);
  }

  /** A forgotten project: its kept comparisons drop. */
  oublier(p: ProjectId): void {
    this.comparaisons.delete(p);
    this.listes.delete(p);
  }
}
