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
export const MAX_LINES = 200;
/** Most comparisons kept per project (a page may show a comparison older than the latest). */
export const KEPT_COMPARISONS = 8;
/** A page asks for a comparison that is no longer kept (or never made). */
export const UNKNOWN_COMPARISON = "Cette comparaison n'est plus gardée : Rafraîchis la relecture.";
/** A comparison's token: its two trees (reviewed, current). */
export const REVIEW_TOKEN = /^[0-9a-f]{40}:[0-9a-f]{40}$/;
const tokenOf = (c: Comparison) => `${c.reviewedTree}:${c.currentTree}`;
export { RANGE_OUTSIDE_BLOCK };
/** "Send" with no unresolved comment. */
export const NO_COMMENT = "Aucun commentaire à envoyer.";

/**
 * A comment's lines, read from the kept diff: those of a single block whose position (new number, that of the next
 * line for a removal) runs from `debut` to `fin`, every position present. null if no block fits.
 */
export function blockLines(diff: DiffFile, start: number, end: number): Comment["lines"] | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  for (const b of diff.blocks) {
    const lines = b.lines.map((l, i) => ({ mark: l.mark, text: l.text, position: newPosition(b, i) }));
    const inside = lines.filter((l) => l.position >= start && l.position <= end);
    const positions = new Set(inside.map((l) => l.position));
    let full = true;
    for (let n = start; n <= end && full; n++) full = positions.has(n);
    if (full) return inside.map(({ mark: mark, text: text }) => ({ mark: mark, text: text }));
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
  private readonly comparisons = new Map<ProjectId, { token: string; repo: ReviewStore; comparison: Comparison }[]>();
  private handling: Promise<void> = Promise.resolve();
  /** Each project's comments (one instance per project). */
  private readonly lists = new Map<ProjectId, ReviewComments>();

  constructor(
    private readonly o: {
      folders: DesignFolders;
      paths: SpacePaths;
      registry: () => ExternalRegistry | null;
      git?: string;
      /** The agent apps' names (their card); the folder name otherwise. */
      siteApps?: () => Promise<{ folder: string; name: string }[]>;
      /** The site apps' names (their site.json); their id otherwise. */
      sites?: () => Promise<{ id: string; name: string }[]>;
      /** The batches of sent comments. */
      remarks: Remarks;
      /** After a batch is written (as in design mode: pre-fill the agent's session; nothing for an external project). */
      send(p: TrackedProject, batch: Batch): Promise<void>;
    },
  ) {}

  private repo(p: ProjectId, folder: string): ReviewStore {
    return new ReviewStore({ repo: reviewStore(this.o.folders, p), folder: folder, ...(this.o.git ? { git: this.o.git } : {}) });
  }

  /**
   * An agent app's folder, if it is a real folder under the projects folder: never a symlink (the container writes
   * into ~/WebAiOs/projects and could plant a link to the home folder there).
   */
  private async appFolder(d: string): Promise<string | null> {
    const folder = join(this.o.paths.projects, d);
    try {
      if (!(await lstat(folder)).isDirectory()) return null;
      const [real, base] = await Promise.all([realpath(folder), realpath(this.o.paths.projects)]);
      return real.startsWith(base + sep) ? folder : null;
    } catch {
      return null;
    }
  }

  /**
   * A site app's folder (`~/WebAiOs/sites/<id>`), if it is a real folder under the sites folder: never a symlink
   * (the agent writes into ~/WebAiOs/sites and could plant a link to the home folder there).
   */
  private async siteFolder(id: string): Promise<string | null> {
    if (!ID_SITE.test(id)) return null;
    const folder = join(this.o.paths.sites, id);
    try {
      if (!(await lstat(folder)).isDirectory()) return null;
      const [real, base] = await Promise.all([realpath(folder), realpath(this.o.paths.sites)]);
      return real.startsWith(base + sep) ? folder : null;
    } catch {
      return null;
    }
  }

  /** One task of the snapshot queue (takeovers, `assurer`, `effacer`): one at a time, in order. */
  private queued(f: () => Promise<void>): Promise<void> {
    const next = this.handling.then(f);
    this.handling = next.catch(() => undefined);
    return next;
  }

  /** A project's first snapshot in its folder, if missing; an error is swallowed (the page will say it). */
  private async snapshot(p: ProjectId, folder: string | null): Promise<void> {
    if (!folder) return;
    try {
      await this.repo(p, folder).ensureReference();
    } catch (e) {
      // git missing, folder unreadable or gone: the page will say so when opened.
      if (!(e instanceof ReviewError)) console.error(`[relecture] prise en charge de ${p} :`, e);
    }
  }

  /** The first snapshot of each app (once per app), one at a time, in the background. */
  handle(folders: string[]): Promise<void> {
    return this.queued(async () => {
      for (const d of folders) {
        const p = `app-${d}`;
        if (!PROJECT_ID.test(p)) continue;
        await this.snapshot(p, await this.appFolder(d));
      }
    });
  }

  /** The first snapshot of each site app, through the same queue; an id outside `ID_SITE` is ignored. */
  handleSites(ids: string[]): Promise<void> {
    return this.queued(async () => {
      for (const id of ids) {
        if (!ID_SITE.test(id)) continue;
        await this.snapshot(`site-${id}`, await this.siteFolder(id));
      }
    });
  }

  /** A site app's first snapshot if missing (before a batch is sent), through the same queue; no effect otherwise. */
  ensure(p: ProjectId): Promise<void> {
    if (!PROJECT_ID.test(p) || !p.startsWith("site-")) return Promise.resolve();
    const id = p.slice(5);
    return this.queued(async () => this.snapshot(p, await this.siteFolder(id)));
  }

  /**
   * A deleted site app: its comparisons and comments forgotten, its review repository and comments file erased. After
   * the queued snapshots (which would otherwise recreate the repository), and through the repository's queue.
   */
  erase(p: ProjectId): Promise<void> {
    if (!PROJECT_ID.test(p)) return Promise.resolve();
    this.forget(p);
    return this.queued(async () => {
      this.forget(p);
      await Promise.all([
        new ReviewStore({ repo: reviewStore(this.o.folders, p), folder: this.o.paths.sites, ...(this.o.git ? { git: this.o.git } : {}) }).delete(),
        rm(commentsFile(this.o.folders, p), { force: true }),
      ]);
    });
  }

  /** The name and folder of a reviewable project; null for a demo, a forgotten external project or a missing folder. */
  async project(p: ProjectId): Promise<{ name: string; folder: string } | null> {
    if (!PROJECT_ID.test(p)) return null;
    if (p.startsWith("app-")) {
      const d = p.slice(4);
      const folder = await this.appFolder(d);
      if (!folder) return null;
      const name = (await this.o.siteApps?.().catch(() => []))?.find((a) => a.folder === d)?.name ?? d;
      return { name: name, folder: folder };
    }
    if (p.startsWith("ext-")) {
      const e = this.o.registry()?.projects().find((x) => `ext-${x.id}` === p);
      return e ? { name: e.name, folder: e.folder } : null;
    }
    if (p.startsWith("site-")) {
      const id = p.slice(5);
      const folder = await this.siteFolder(id);
      if (!folder) return null;
      const name = (await this.o.sites?.().catch(() => []))?.find((s) => s.id === id)?.name ?? id;
      return { name: name, folder: folder };
    }
    return null;
  }

  /**
   * With the token of a kept comparison: that one, without comparing again (a remounted page shows the same thing).
   * Without a token (or if it is no longer kept): a new comparison, kept at the head.
   */
  async open(p: ProjectId, token?: string): Promise<ReviewView> {
    const project = await this.project(p);
    if (!project) {
      this.comparisons.delete(p);
      return { state: "unavailable", name: p, reason: UNKNOWN_PROJECT };
    }
    try {
      let g = token ? this.comparisons.get(p)?.find((x) => x.token === token) : undefined;
      if (!g) {
        const repo = this.repo(p, project.folder);
        const comparison = await repo.compare();
        g = { token: tokenOf(comparison), repo, comparison: comparison };
        const others = (this.comparisons.get(p) ?? []).filter((x) => x.token !== g!.token);
        this.comparisons.set(p, [g, ...others].slice(0, KEPT_COMPARISONS));
      }
      const comments = await this.pasteAll(p, g);
      return {
        state: "ok", name: project.name, token: g.token, comparison: { files: g.comparison.files }, comments: comments,
        ...this.destination(await this.tracking(p)),
      };
    } catch (e) {
      if (e instanceof ReviewError) return { state: "unavailable", name: project.name, reason: e.reason };
      console.error(`[relecture] comparaison de ${p} :`, e);
      return { state: "unavailable", name: project.name, reason: "la comparaison a échoué" };
    }
  }

  private guard(p: ProjectId, token: string, path: string) {
    const g = this.comparisons.get(p)?.find((x) => x.token === token);
    if (!g) throw new Error(UNKNOWN_COMPARISON);
    const f = g.comparison.files.find((x) => x.path === path);
    if (!f) throw new Error("fichier absent de la relecture");
    return { ...g, file: f };
  }

  /** The comparison of a kept token ("Marquer comme relu" keeps the tree the page showed). */
  comparison(p: ProjectId, token: string): { repo: ReviewStore; comparison: Comparison } | null {
    return this.comparisons.get(p)?.find((x) => x.token === token) ?? null;
  }

  async file(p: ProjectId, token: string, path: string): Promise<DiffFile> {
    const g = this.guard(p, token, path);
    const diff = await g.repo.file(g.comparison, path);
    // Not displayable: its comments stay as they are.
    if (diff.displayable === true) await this.commentsOf(p).pasteFile(path, diff);
    return diff;
  }

  /** Lines of the current version (never of a deleted or non-displayable file). */
  async lines(p: ProjectId, token: string, path: string, start: number, end: number): Promise<string[]> {
    const g = this.guard(p, token, path);
    if (g.file.status === "deleted" || g.file.displayable !== true) return [];
    const a = Math.max(1, Math.floor(start));
    const b = Math.min(Math.floor(end), a + MAX_LINES - 1);
    if (b < a) return [];
    // One more line: if it is missing, the end of the file is reached and its last "\n" does not make an empty line.
    const l = await g.repo.lines(g.comparison.currentTree, path, a, b + 1);
    if (l.length > b - a + 1) return l.slice(0, b - a + 1);
    return l.at(-1) === "" ? l.slice(0, -1) : l;
  }

  /** A single instance per project: its write queue serialises every change to its comments. */
  private commentsOf(p: ProjectId): ReviewComments {
    let c = this.lists.get(p);
    if (!c) {
      c = new ReviewComments(commentsFile(this.o.folders, p));
      this.lists.set(p, c);
    }
    return c;
  }

  /**
   * The comments re-anchored to the shown comparison's diff. Those of a file absent from the comparison (reviewed,
   * unchanged since) or not displayable stay as they are: nothing says their lines changed.
   */
  private async pasteAll(p: ProjectId, g: { repo: ReviewStore; comparison: Comparison }): Promise<Comment[]> {
    const comments = this.commentsOf(p);
    const files = new Set((await comments.list()).map((c) => c.file));
    for (const path of files) {
      const f = g.comparison.files.find((x) => x.path === path);
      if (!f || f.displayable !== true) continue;
      const diff = await g.repo.file(g.comparison, path).catch(() => null);
      if (diff && diff.displayable === true) await comments.pasteFile(path, diff);
    }
    return comments.list();
  }

  /** The followed project (destination of the send); null for an unknown project. */
  private async tracking(p: ProjectId): Promise<TrackedProject | null> {
    const project = await this.project(p);
    if (!project) return null;
    if (p.startsWith("app-")) return { type: "app", project: p, folder: p.slice(4), name: project.name };
    if (p.startsWith("site-")) return projectForSite(p.slice(5), project.name);
    const e = this.o.registry()?.projects().find((x) => `ext-${x.id}` === p);
    return e ? { type: "externe", project: p, folder: e.folder, name: e.name, client: e.client } : null;
  }

  private destination(s: TrackedProject | null): { destination: string | null; noDestination: string | null } {
    if (!s) return { destination: null, noDestination: UNKNOWN_PROJECT };
    const d = destinationOf(s, this.o.registry()?.clients() ?? []);
    return "label" in d ? { destination: d.label, noDestination: null } : { destination: null, noDestination: d.unavailable };
  }

  /** The project's comments, as stored (without re-anchoring). */
  comments(p: ProjectId): Promise<Comment[]> {
    return this.commentsOf(p).list();
  }

  /** A comment on lines `debut`..`fin` of a file of the token's comparison, read here from the kept diff. */
  async comment(p: ProjectId, token: string, c: { file: string; start: number; end: number; text: string }): Promise<ExtensionResult> {
    try {
      if (c.text.trim() === "") return { ok: false, error: EMPTY_REMARK };
      const g = this.guard(p, token, c.file);
      const diff = await g.repo.file(g.comparison, c.file);
      const lines = diff.displayable === true ? blockLines(diff, c.start, c.end) : null;
      if (!lines) return { ok: false, error: RANGE_OUTSIDE_BLOCK };
      await this.commentsOf(p).add({ file: c.file, start: c.start, end: c.end, lines, text: c.text });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  editComment(p: ProjectId, id: string, text: string): Promise<void> {
    return this.commentsOf(p).edit(id, text);
  }

  resolve(p: ProjectId, id: string, resolved: boolean): Promise<void> {
    return this.commentsOf(p).resolve(id, resolved);
  }

  deleteComment(p: ProjectId, id: string): Promise<void> {
    return this.commentsOf(p).delete(id);
  }

  /** The unresolved comments (already-sent ones included) become a batch for the agent or the connected Claude Code. */
  async send(p: ProjectId): Promise<ExtensionResult> {
    try {
      const s = await this.tracking(p);
      if (!s) return { ok: false, error: UNKNOWN_PROJECT };
      let destination: { destination: "agent" | "mcp"; client?: string } = { destination: "agent" };
      if (s.type === "externe") {
        const d = destinationOf(s, this.o.registry()?.clients() ?? []);
        if ("unavailable" in d || s.client === null) return { ok: false, error: NO_CLIENT };
        destination = { destination: "mcp", client: s.client };
      }
      const comments = this.commentsOf(p);
      const a = await comments.toSend();
      if (a.length === 0) return { ok: false, error: NO_COMMENT };
      const batch = await this.o.remarks.sendReview(
        p,
        a.map((c) => ({ text: c.text, context: { file: c.file, start: c.start, end: c.end, lines: c.lines } })),
        destination,
      );
      // A comment edited during the send stays "not sent": its new text did not go.
      await comments.markSentIfUnchanged(a.map((c) => ({ id: c.id, text: c.text })));
      await this.o.send(s, batch);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * "Marquer comme relu": keeps the tree the page showed (the token's), never a new state: what changed since stays to
   * review. Resolved comments go; the project's kept comparisons drop (another page can no longer keep an older tree);
   * then a new comparison.
   */
  async reviewed(p: ProjectId, token: string): Promise<ReviewView> {
    const g = this.comparison(p, token);
    if (!g) throw new Error(UNKNOWN_COMPARISON);
    await g.repo.keep(g.comparison.currentTree);
    await this.commentsOf(p).afterReviewed();
    this.comparisons.delete(p);
    return this.open(p);
  }

  /** A forgotten project: its kept comparisons drop. */
  forget(p: ProjectId): void {
    this.comparisons.delete(p);
    this.lists.delete(p);
  }
}
