// The host side of design mode: remarks, the external MCP server and the review, started
// with the host and without the agent's kernel. Each RPC input is checked again with
// the shared guards (shared/design-guards.ts) before the service.
// The kernel is imported first: core/design/externes.ts and envoi.ts load under tsx only once it is linked.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  destinationDe, batchState, PORT_MCP_EXTERNE, containerRanges, demoProject, projectForUrl, projectForAppWindow, projectForSite, ExternalRegistry, Remarques,
  EMPTY_REMARK, SANS_CLIENT, type Application, type SpacePaths, type DesignContext, type Element, type ProjectId, type Lot, type TrackedProject,
} from "../../../packages/noyau/src/index.ts";
import { startExternals, failureReason, type ServiceExternes } from "../core/design/externes.ts";
import { createSend } from "../core/design/envoi.ts";
import type { ShownElement, ExternalsState, BatchShown, ExtensionResult } from "../shared/api.ts";
import { ReviewService } from "./review.ts";
import {
  checkCapture, checkClientName, checkComment, checkDesignContext, checkLines, checkPath, checkProject, checkResolved, checkText, checkToken, CLIENT_ID,
  DESIGN_ID_MAX, EXTERNAL_ID, ID_PROJECT, INVALID_REQUEST, REMARK_TEXT_MAX, URL_MAX,
} from "../shared/design-guards.ts";

/** The external MCP port: the asked one, else 5279; a bad value gives NaN, which the server refuses. */
export const externalMcpPort = (v: string | undefined): number => Number(v ?? PORT_MCP_EXTERNE);

export function textSource(s: DesignContext["source"]): string | null {
  if (!s) return null;
  return s.ligne !== undefined ? `${s.fichier}:${s.ligne}` : s.fichier;
}

export function shownElement(e: Element): ShownElement {
  const base = { id: e.id, type: e.type, texte: e.texte, traite: e.traite ?? null };
  return e.type === "design"
    ? { ...base, etiquette: e.contexte.etiquette, source: textSource(e.contexte.source) }
    : { ...base, etiquette: `${e.contexte.fichier}:${e.contexte.debut}-${e.contexte.fin}`, source: e.contexte.fichier };
}

export function batchShown(l: Lot): BatchShown {
  return { id: l.id, cree: l.cree, etat: batchState(l), destination: l.destination, elements: l.elements.map(shownElement) };
}

/** A followed project as the chrome shows it: its cart count, its destination, its name (ServiceDesign.etat). */
export interface DesignTracking {
  projet: TrackedProject;
  panier: number;
  destination: string | null;
  sansDestination: string | null;
  nom: string;
}

export interface DesignHost {
  handlers: Record<string, (p: any) => unknown>;
  /** The site apps list changed: after 1 s of calm, their first review snapshot. */
  sitesChanged(): void;
  /** The agent apps list changed: the same takeover, after 1 s of calm. */
  appsChanged(): void;
  /** A deleted site app: its remarks, review repository and comments erased. */
  siteDeleted(id: string): void;
  arreter(): Promise<void>;
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
  chemins: SpacePaths;
  port: number;
  maison?: string;
  sites(): Promise<{ id: string; nom: string }[]>;
  /** Every agent app, running or not (their first snapshot, their name on the Review page). */
  applis(): Promise<Application[]>;
  preRemplir(win: string, text: string): void;
  chrome: { fenetreAgent(): Promise<string | null>; donnerAgent(win: string): void };
  notifier(n: { titre: string; texte: string }): void;
  diffuser(): void;
}): DesignHost {
  // The batches of agent projects go in the space (the agent reads them); external projects' registries, review
  // repositories and batches go under <dataDir>/design, never mounted in the container.
  const dossiers = { remarquesEspace: join(o.chemins.interne, "remarques"), prive: join(o.dataDir, "design") };
  const remarques = new Remarques({ dossiers });
  let registry: ExternalRegistry | null = null;
  let externes: ServiceExternes | null = null;
  let failure: string | null = null;

  // The batch sent to the agent: one pre-filled line in its session, never sent. The chrome reopens a window if needed
  // and design.donnerAgent brings it to the front.
  const batchSend = async (p: TrackedProject, lot: Lot): Promise<void> => {
    if (p.type === "externe") return;
    const f = await o.chrome.fenetreAgent();
    await createSend({
      chemins: o.chemins,
      fenetreAgent: () => f ?? undefined,
      dossierLot: (pr, l) => remarques.dossierLot(pr, l),
      preRemplir: o.preRemplir,
      donnerLeTerminal: (w) => o.chrome.donnerAgent(w),
      devant: () => {},
    })(p, lot);
  };
  const review = new ReviewService({ dossiers, chemins: o.chemins, registre: () => registry, applis: o.applis, sites: o.sites, remarques, envoyer: batchSend });

  // The apps with a manifest, then the site apps, each through the review's queue.
  const takeOver = () => {
    void o
      .applis()
      .then((l) => review.priseEnCharge(l.filter((a) => a.type !== "sans-fiche").map((a) => a.dossier)))
      .catch((e) => console.error("[relecture] prise en charge :", e));
    void o
      .sites()
      .then((l) => review.priseEnChargeSites(l.map((s) => s.id)))
      .catch((e) => console.error("[relecture] prise en charge des sites :", e));
  };
  let takeOverTimer: NodeJS.Timeout | undefined;
  const takeOverSoon = () => {
    clearTimeout(takeOverTimer);
    takeOverTimer = setTimeout(takeOver, 1000);
  };
  takeOver();

  // Handled and outdated batches are purged at start, then every 24 hours.
  void remarques.purger().catch(() => undefined);
  const purge = setInterval(() => void remarques.purger().catch(() => undefined), 24 * 60 * 60 * 1000);
  purge.unref();
  remarques.surChange(o.diffuser);
  const started = ExternalRegistry.ouvrir(dossiers.prive)
    .then((r) => {
      registry = r;
      r.surChange(o.diffuser);
      // Never another port when this one is held.
      return startExternals({
        registre: r,
        remarques,
        dossiers,
        port: o.port,
        plages: containerRanges(process.env.WEBAIOS_PORTS_APPS),
        // Stricter than the space root: nothing under the profile folder can be declared.
        racineEspace: o.dataDir,
        maison: o.maison ?? homedir(),
        notifier: o.notifier,
      }).then((service) => {
        externes = service;
        o.diffuser();
      });
    })
    .catch((e) => {
      console.error("[design] projets externes indisponibles :", e);
      failure = failureReason(e);
      o.diffuser();
    });

  // The design service's project logic: applis() is the running apps with a port.
  const running = async () => (await o.applis()).flatMap((a) => (a.etat === "en-marche" && a.port !== undefined ? [{ dossier: a.dossier, nom: a.nom, port: a.port }] : []));
  const trackedProject = async (p: ProjectId): Promise<TrackedProject | null> => {
    if (p.startsWith("app-")) {
      const dossier = p.slice(4);
      return projectForAppWindow(dossier, (await running()).find((a) => a.dossier === dossier)?.nom ?? dossier);
    }
    if (p.startsWith("site-")) {
      const id = p.slice(5);
      const site = (await o.sites()).find((x) => x.id === id);
      return site ? projectForSite(id, site.nom) : null;
    }
    if (p.startsWith("demo-")) return { type: "demo", projet: demoProject(Number(p.slice(5))), port: Number(p.slice(5)) };
    const e = registry?.projets().find((x) => `ext-${x.id}` === p);
    return e ? { type: "externe", projet: p, dossier: e.dossier, nom: e.nom, client: e.client } : null;
  };
  const destination = (p: TrackedProject) => {
    const d = destinationDe(p, registry?.clients() ?? []);
    return "libelle" in d ? { destination: d.libelle, sansDestination: null } : { destination: null, sansDestination: d.indisponible };
  };
  const tracking = async (p: Params): Promise<DesignTracking | null> => {
    let project: TrackedProject | null;
    if (typeof p?.url === "string" && p.url.length <= URL_MAX)
      project = projectForUrl(p.url, { appsLancees: await running(), plages: containerRanges(process.env.WEBAIOS_PORTS_APPS), externes: registry?.projets() ?? [] });
    else if (p?.url === undefined && p?.projet !== undefined) project = await trackedProject(checkProject(p.projet));
    else throw new Error(INVALID_REQUEST);
    if (!project) return null;
    const basket = (await remarques.panier(project.projet)).length;
    return { projet: project, panier: basket, ...destination(project), nom: project.type === "demo" ? `localhost:${project.port}` : project.nom };
  };
  const error = (e: unknown): ExtensionResult => ({ ok: false, erreur: e instanceof Error ? e.message : String(e) });
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
      return { ok: false, erreur: INVALID_REQUEST };
    }
    if (text.trim() === "") return { ok: false, erreur: EMPTY_REMARK };
    try {
      await remarques.ajouterAuPanier(project, { texte: text, contexte: context, capture });
      return { ok: true };
    } catch (e) {
      return error(e);
    }
  };
  // The design service's send, with a site snapshot before the first batch.
  const send = async (p: Params): Promise<ExtensionResult> => {
    if (!projectId(p?.projet)) return { ok: false, erreur: INVALID_REQUEST };
    const project = await trackedProject(p.projet);
    if (!project) return { ok: false, erreur: SANS_CLIENT };
    let dest: { destination: "agent" | "mcp"; client?: string } = { destination: "agent" };
    if (project.type === "externe") {
      const d = destinationDe(project, registry?.clients() ?? []);
      if ("indisponible" in d || project.client === null) return { ok: false, erreur: SANS_CLIENT };
      dest = { destination: "mcp", client: project.client };
    }
    try {
      const lot = await remarques.envoyerPanier(project.projet, dest);
      if (project.type === "site") await review.assurer(project.projet).catch(() => undefined);
      await batchSend(project, lot);
      return { ok: true };
    } catch (e) {
      return error(e);
    }
  };
  const id = (v: unknown): v is string => typeof v === "string" && v.length <= DESIGN_ID_MAX;
  const projectId = (v: unknown): v is ProjectId => typeof v === "string" && ID_PROJECT.test(v);

  const handlers: Record<(typeof DESIGN_METHODS)[number], (p: Params) => unknown> = {
    "externes.liste": (): ExternalsState =>
      externes?.etat() ?? { serveur: { etat: "eteint", raison: failure ?? "Le MCP externe démarre" }, projets: [], clients: [] },
    "externes.brancher": (p) => {
      const name = checkClientName(p?.nom);
      if (!externes) throw new Error(failure ?? "Le MCP externe démarre");
      return externes.brancher(name);
    },
    // A bad id does nothing.
    "externes.revoquer": async (p) => {
      if (typeof p?.id === "string" && CLIENT_ID.test(p.id)) await externes?.revoquer(p.id);
    },
    "externes.oublier": async (p) => {
      if (typeof p?.id !== "string" || !EXTERNAL_ID.test(p.id)) return;
      await externes?.oublier(p.id);
      review.oublier(`ext-${p.id}`);
    },
    "externes.nom": (p) => (typeof p?.id === "string" ? (registry?.projets().find((x) => x.id === p.id)?.nom ?? null) : null),
    "relecture.ouvrir": (p) => review.ouvrir(checkProject(p?.projet), p?.jeton === undefined || p.jeton === null ? undefined : checkToken(p.jeton)),
    "relecture.fichier": (p) => review.fichier(checkProject(p?.projet), checkToken(p?.jeton), checkPath(p?.chemin)),
    "relecture.lignes": (p) => {
      const project = checkProject(p?.projet);
      const [debut, fin] = checkLines(p?.debut, p?.fin);
      return review.lignes(project, checkToken(p?.jeton), checkPath(p?.chemin), debut, fin);
    },
    "relecture.commentaires": (p) => review.commentaires(checkProject(p?.projet)),
    "relecture.commenter": (p) => {
      const project = checkProject(p?.projet);
      const c = p?.c;
      if (typeof c !== "object" || c === null) throw new Error("lignes invalides");
      const x = c as Record<string, unknown>;
      const [debut, fin] = checkLines(x.debut, x.fin);
      return review.commenter(project, checkToken(p?.jeton), { fichier: checkPath(x.fichier), debut, fin, texte: checkText(x.texte) });
    },
    "relecture.modifierCommentaire": (p) => review.modifierCommentaire(checkProject(p?.projet), checkComment(p?.id), checkText(p?.texte)),
    "relecture.resoudre": (p) => {
      const project = checkProject(p?.projet);
      const resolved = checkResolved(p?.resolu);
      return review.resoudre(project, checkComment(p?.id), resolved);
    },
    "relecture.supprimerCommentaire": (p) => review.supprimerCommentaire(checkProject(p?.projet), checkComment(p?.id)),
    "relecture.envoyer": (p) => review.envoyer(checkProject(p?.projet)),
    "relecture.relu": (p) => review.relu(checkProject(p?.projet), checkToken(p?.jeton)),
    "design.suivi": tracking,
    "design.ajouter": add,
    // A bad project or id answers an empty list, or nothing.
    "design.panier": async (p) => (projectId(p?.projet) ? (await remarques.panier(p.projet)).map(shownElement) : []),
    "design.lots": async (p) => (projectId(p?.projet) ? (await remarques.lots(p.projet)).map(batchShown) : []),
    "design.retirer": async (p) => {
      if (projectId(p?.projet) && id(p?.id)) await remarques.retirerDuPanier(p.projet, p.id);
    },
    "design.traite": async (p) => {
      if (projectId(p?.projet) && id(p?.lot)) await remarques.marquerLotTraite(p.projet, p.lot);
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
      void remarques.oublier(p).catch((e) => console.error(`[design] remarques de ${id} non effacées :`, e));
      void review.effacer(p).catch((e) => console.error(`[relecture] relecture de ${id} non effacée :`, e));
    },
    arreter: async () => {
      clearInterval(purge);
      clearTimeout(takeOverTimer);
      // A server still starting would otherwise outlive the host.
      await started;
      await externes?.arreter();
    },
  };
}
