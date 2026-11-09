// The host side of design mode: remarks, the external MCP server and the review, started
// with the host and without the agent's kernel. Each RPC input is checked again with
// the shared guards (shared/design-guards.ts) before the service.
// The kernel is imported first: core/design/external.ts and send.ts load under tsx only once it is linked.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  destinationOf, batchState, EXTERNAL_MCP_PORT, containerRanges, demoProject, projectForUrl, projectForAppWindow, projectForSite, ExternalRegistry, Remarks,
  EMPTY_REMARK, NO_CLIENT, type Application, type SpacePaths, type DesignContext, type Element, type ProjectId, type Batch, type TrackedProject,
} from "../../../packages/kernel/src/index.ts";
import { startExternals, failureReason, type ExternalService } from "../core/design/external.ts";
import { createSend } from "../core/design/send.ts";
import type { ShownElement, ExternalsState, BatchShown, ExtensionResult } from "../shared/api.ts";
import { ReviewService } from "./review.ts";
import {
  checkCapture, checkClientName, checkComment, checkDesignContext, checkLines, checkPath, checkProject, checkResolved, checkText, checkToken, CLIENT_ID,
  DESIGN_ID_MAX, EXTERNAL_ID, ID_PROJECT, INVALID_REQUEST, REMARK_TEXT_MAX, URL_MAX,
} from "../shared/design-guards.ts";

/** The external MCP port: the asked one, else 5279; a bad value gives NaN, which the server refuses. */
export const externalMcpPort = (v: string | undefined): number => Number(v ?? EXTERNAL_MCP_PORT);

export function textSource(s: DesignContext["source"]): string | null {
  if (!s) return null;
  return s.line !== undefined ? `${s.file}:${s.line}` : s.file;
}

export function shownElement(e: Element): ShownElement {
  const base = { id: e.id, type: e.type, text: e.text, handled: e.handled ?? null };
  return e.type === "design"
    ? { ...base, label: e.context.label, source: textSource(e.context.source) }
    : { ...base, label: `${e.context.file}:${e.context.start}-${e.context.end}`, source: e.context.file };
}

export function batchShown(l: Batch): BatchShown {
  return { id: l.id, created: l.created, state: batchState(l), destination: l.destination, items: l.items.map(shownElement) };
}

/** A followed project as the chrome shows it: its cart count, its destination, its name (ServiceDesign.etat). */
export interface DesignTracking {
  project: TrackedProject;
  basket: number;
  destination: string | null;
  noDestination: string | null;
  name: string;
}

export interface DesignHost {
  handlers: Record<string, (p: any) => unknown>;
  /** The site apps list changed: after 1 s of calm, their first review snapshot. */
  sitesChanged(): void;
  /** The agent apps list changed: the same takeover, after 1 s of calm. */
  appsChanged(): void;
  /** A deleted site app: its remarks, review repository and comments erased. */
  siteDeleted(id: string): void;
  stop(): Promise<void>;
}

type Params = { [k: string]: unknown } | null | undefined;

export const DESIGN_METHODS = [
  "externes.liste", "externes.brancher", "externes.revoquer", "externes.oublier", "externes.nom",
  "relecture.ouvrir", "relecture.fichier", "relecture.lignes", "relecture.commentaires", "relecture.commenter",
  "relecture.modifierCommentaire", "relecture.resoudre", "relecture.supprimerCommentaire", "relecture.envoyer", "relecture.relu",
  "design.suivi", "design.ajouter", "design.panier", "design.lots", "design.retirer", "design.traite", "design.envoyer",
] as const;

export function createDesignHost(o: {
  dataDir: string;
  paths: SpacePaths;
  port: number;
  home?: string;
  sites(): Promise<{ id: string; name: string }[]>;
  /** Every agent app, running or not (their first snapshot, their name on the Review page). */
  siteApps(): Promise<Application[]>;
  prefill(win: string, text: string): void;
  chrome: { agentWindow(): Promise<string | null>; giveAgent(win: string): void };
  notify(n: { title: string; text: string }): void;
  broadcast(): void;
}): DesignHost {
  // The batches of agent projects go in the space (the agent reads them); external projects' registries, review
  // repositories and batches go under <dataDir>/design, never mounted in the container.
  const folders = { spaceRemarks: join(o.paths.internal, "remarques"), private: join(o.dataDir, "design") };
  const remarks = new Remarks({ folders: folders });
  let registry: ExternalRegistry | null = null;
  let externals: ExternalService | null = null;
  let failure: string | null = null;

  // The batch sent to the agent: one pre-filled line in its session, never sent. The chrome reopens a window if needed
  // and design.donnerAgent brings it to the front.
  const batchSend = async (p: TrackedProject, batch: Batch): Promise<void> => {
    if (p.type === "externe") return;
    const f = await o.chrome.agentWindow();
    await createSend({
      paths: o.paths,
      agentWindow: () => f ?? undefined,
      batchFolder: (pr, l) => remarks.batchFolder(pr, l),
      prefill: o.prefill,
      giveTerminal: (w) => o.chrome.giveAgent(w),
      toFront: () => {},
    })(p, batch);
  };
  const review = new ReviewService({ folders: folders, paths: o.paths, registry: () => registry, siteApps: o.siteApps, sites: o.sites, remarks: remarks, send: batchSend });

  // The apps with a manifest, then the site apps, each through the review's queue.
  const takeOver = () => {
    void o
      .siteApps()
      .then((l) => review.handle(l.filter((a) => a.type !== "sans-fiche").map((a) => a.folder)))
      .catch((e) => console.error("[relecture] prise en charge :", e));
    void o
      .sites()
      .then((l) => review.handleSites(l.map((s) => s.id)))
      .catch((e) => console.error("[relecture] prise en charge des sites :", e));
  };
  let takeOverTimer: NodeJS.Timeout | undefined;
  const takeOverSoon = () => {
    clearTimeout(takeOverTimer);
    takeOverTimer = setTimeout(takeOver, 1000);
  };
  takeOver();

  // Handled and outdated batches are purged at start, then every 24 hours.
  void remarks.purge().catch(() => undefined);
  const purge = setInterval(() => void remarks.purge().catch(() => undefined), 24 * 60 * 60 * 1000);
  purge.unref();
  remarks.onChange(o.broadcast);
  const started = ExternalRegistry.open(folders.private)
    .then((r) => {
      registry = r;
      r.onChange(o.broadcast);
      // Never another port when this one is held.
      return startExternals({
        registry: r,
        remarks: remarks,
        folders: folders,
        port: o.port,
        ranges: containerRanges(process.env.WEBAIOS_PORTS_APPS),
        // Stricter than the space root: nothing under the profile folder can be declared.
        spaceRoot: o.dataDir,
        home: o.home ?? homedir(),
        notify: o.notify,
      }).then((service) => {
        externals = service;
        o.broadcast();
      });
    })
    .catch((e) => {
      console.error("[design] projets externes indisponibles :", e);
      failure = failureReason(e);
      o.broadcast();
    });

  // The design service's project logic: applis() is the running apps with a port.
  const running = async () => (await o.siteApps()).flatMap((a) => (a.state === "en-marche" && a.port !== undefined ? [{ folder: a.folder, name: a.name, port: a.port }] : []));
  const trackedProject = async (p: ProjectId): Promise<TrackedProject | null> => {
    if (p.startsWith("app-")) {
      const folder = p.slice(4);
      return projectForAppWindow(folder, (await running()).find((a) => a.folder === folder)?.name ?? folder);
    }
    if (p.startsWith("site-")) {
      const id = p.slice(5);
      const site = (await o.sites()).find((x) => x.id === id);
      return site ? projectForSite(id, site.name) : null;
    }
    if (p.startsWith("demo-")) return { type: "demo", project: demoProject(Number(p.slice(5))), port: Number(p.slice(5)) };
    const e = registry?.projects().find((x) => `ext-${x.id}` === p);
    return e ? { type: "externe", project: p, folder: e.folder, name: e.name, client: e.client } : null;
  };
  const destination = (p: TrackedProject) => {
    const d = destinationOf(p, registry?.clients() ?? []);
    return "label" in d ? { destination: d.label, noDestination: null } : { destination: null, noDestination: d.unavailable };
  };
  const tracking = async (p: Params): Promise<DesignTracking | null> => {
    let project: TrackedProject | null;
    if (typeof p?.url === "string" && p.url.length <= URL_MAX)
      project = projectForUrl(p.url, { launchedApps: await running(), ranges: containerRanges(process.env.WEBAIOS_PORTS_APPS), external: registry?.projects() ?? [] });
    else if (p?.url === undefined && p?.projet !== undefined) project = await trackedProject(checkProject(p.projet));
    else throw new Error(INVALID_REQUEST);
    if (!project) return null;
    const basket = (await remarks.basket(project.project)).length;
    return { project: project, basket: basket, ...destination(project), name: project.type === "demo" ? `localhost:${project.port}` : project.name };
  };
  const error = (e: unknown): ExtensionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });
  const add = async (p: Params): Promise<ExtensionResult> => {
    let project: ProjectId, context: DesignContext, capture: Buffer | null;
    const text = p?.texte;
    try {
      if (typeof text !== "string" || text.length > REMARK_TEXT_MAX) throw new Error(INVALID_REQUEST);
      project = checkProject(p?.projet);
      context = checkDesignContext(p?.contexte);
      capture = checkCapture(p?.capture);
      // A forgotten external project gets no cart.
      if (!(await trackedProject(project))) throw new Error(INVALID_REQUEST);
    } catch {
      return { ok: false, error: INVALID_REQUEST };
    }
    if (text.trim() === "") return { ok: false, error: EMPTY_REMARK };
    try {
      await remarks.addToBasket(project, { text: text, context: context, capture });
      return { ok: true };
    } catch (e) {
      return error(e);
    }
  };
  // The design service's send, with a site snapshot before the first batch.
  const send = async (p: Params): Promise<ExtensionResult> => {
    if (!projectId(p?.projet)) return { ok: false, error: INVALID_REQUEST };
    const project = await trackedProject(p.projet);
    if (!project) return { ok: false, error: NO_CLIENT };
    let dest: { destination: "agent" | "mcp"; client?: string } = { destination: "agent" };
    if (project.type === "externe") {
      const d = destinationOf(project, registry?.clients() ?? []);
      if ("unavailable" in d || project.client === null) return { ok: false, error: NO_CLIENT };
      dest = { destination: "mcp", client: project.client };
    }
    try {
      const batch = await remarks.sendBasket(project.project, dest);
      if (project.type === "site") await review.ensure(project.project).catch(() => undefined);
      await batchSend(project, batch);
      return { ok: true };
    } catch (e) {
      return error(e);
    }
  };
  const id = (v: unknown): v is string => typeof v === "string" && v.length <= DESIGN_ID_MAX;
  const projectId = (v: unknown): v is ProjectId => typeof v === "string" && ID_PROJECT.test(v);

  const handlers: Record<(typeof DESIGN_METHODS)[number], (p: Params) => unknown> = {
    "externes.liste": (): ExternalsState =>
      externals?.state() ?? { server: { state: "eteint", reason: failure ?? "Le MCP externe démarre" }, projects: [], clients: [] },
    "externes.brancher": (p) => {
      const name = checkClientName(p?.nom);
      if (!externals) throw new Error(failure ?? "Le MCP externe démarre");
      return externals.connect(name);
    },
    // A bad id does nothing.
    "externes.revoquer": async (p) => {
      if (typeof p?.id === "string" && CLIENT_ID.test(p.id)) await externals?.revoke(p.id);
    },
    "externes.oublier": async (p) => {
      if (typeof p?.id !== "string" || !EXTERNAL_ID.test(p.id)) return;
      await externals?.forget(p.id);
      review.forget(`ext-${p.id}`);
    },
    "externes.nom": (p) => (typeof p?.id === "string" ? (registry?.projects().find((x) => x.id === p.id)?.name ?? null) : null),
    "relecture.ouvrir": (p) => review.open(checkProject(p?.projet), p?.jeton === undefined || p.jeton === null ? undefined : checkToken(p.jeton)),
    "relecture.fichier": (p) => review.file(checkProject(p?.projet), checkToken(p?.jeton), checkPath(p?.chemin)),
    "relecture.lignes": (p) => {
      const project = checkProject(p?.projet);
      const [start, end] = checkLines(p?.debut, p?.fin);
      return review.lines(project, checkToken(p?.jeton), checkPath(p?.chemin), start, end);
    },
    "relecture.commentaires": (p) => review.comments(checkProject(p?.projet)),
    "relecture.commenter": (p) => {
      const project = checkProject(p?.projet);
      const c = p?.c;
      if (typeof c !== "object" || c === null) throw new Error("lignes invalides");
      const x = c as Record<string, unknown>;
      const [start, end] = checkLines(x.debut, x.fin);
      return review.comment(project, checkToken(p?.jeton), { file: checkPath(x.fichier), start: start, end: end, text: checkText(x.texte) });
    },
    "relecture.modifierCommentaire": (p) => review.editComment(checkProject(p?.projet), checkComment(p?.id), checkText(p?.texte)),
    "relecture.resoudre": (p) => {
      const project = checkProject(p?.projet);
      const resolved = checkResolved(p?.resolu);
      return review.resolve(project, checkComment(p?.id), resolved);
    },
    "relecture.supprimerCommentaire": (p) => review.supprimerCommentaire(checkProject(p?.projet), checkComment(p?.id)),
    "relecture.envoyer": (p) => review.send(checkProject(p?.projet)),
    "relecture.relu": (p) => review.reviewed(checkProject(p?.projet), checkToken(p?.jeton)),
    "design.suivi": tracking,
    "design.ajouter": add,
    // A bad project or id answers an empty list, or nothing.
    "design.panier": async (p) => (projectId(p?.projet) ? (await remarks.basket(p.projet)).map(shownElement) : []),
    "design.lots": async (p) => (projectId(p?.projet) ? (await remarks.batches(p.projet)).map(batchShown) : []),
    "design.retirer": async (p) => {
      if (projectId(p?.projet) && id(p?.id)) await remarks.removeFromBasket(p.projet, p.id);
    },
    "design.traite": async (p) => {
      if (projectId(p?.projet) && id(p?.lot)) await remarks.markBatchHandled(p.projet, p.lot);
    },
    "design.envoyer": send,
  };

  return {
    handlers,
    sitesChanged: takeOverSoon,
    appsChanged: takeOverSoon,
    siteDeleted: (id) => {
      const p = `site-${id}`;
      if (!ID_PROJECT.test(p)) return;
      void remarks.forget(p).catch((e) => console.error(`[design] remarques de ${id} non effacées :`, e));
      void review.erase(p).catch((e) => console.error(`[relecture] relecture de ${id} non effacée :`, e));
    },
    stop: async () => {
      clearInterval(purge);
      clearTimeout(takeOverTimer);
      // A server still starting would otherwise outlive the host.
      await started;
      await externals?.stop();
    },
  };
}
