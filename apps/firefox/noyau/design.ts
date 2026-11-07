// The host side of design mode: remarks, the external MCP server (Electron's demarrerExternes) and the review, started
// with the host and without the agent's noyau, as main/index.ts:1074-1205. Each RPC input is checked again with
// ipc.ts's guards (shared/design-guards.ts) before the service.
// The noyau is imported first: Electron's externes.ts and envoi.ts load under tsx only once it is linked.
import { homedir } from "node:os";
import { join } from "node:path";
import { PORT_MCP_EXTERNE, plagesConteneur, RegistreExternes, Remarques, type Application, type CheminsEspace, type Lot, type ProjetSuivi } from "../../../packages/noyau/src/index.ts";
import { demarrerExternes, raisonEchec, type ServiceExternes } from "../../navigateur/src/main/design/externes.ts";
import { creerEnvoi } from "../../navigateur/src/main/design/envoi.ts";
import type { EtatExternes } from "../../navigateur/src/commun/api.ts";
import { ReviewService } from "./review.ts";
import { checkClientName, checkComment, checkLines, checkPath, checkProject, checkResolved, checkText, checkToken, CLIENT_ID, EXTERNAL_ID, ID_PROJECT } from "../shared/design-guards.ts";

/** The external MCP port: the asked one, else 5279; a bad value gives NaN, which the server refuses (as index.ts:1192). */
export const externalMcpPort = (v: string | undefined): number => Number(v ?? PORT_MCP_EXTERNE);

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
] as const;

export function createDesignHost(o: {
  dataDir: string;
  chemins: CheminsEspace;
  port: number;
  maison?: string;
  sites(): Promise<{ id: string; nom: string }[]>;
  /** Every agent app, running or not (their first snapshot, their name on the Review page). */
  applis(): Promise<Application[]>;
  preRemplir(fenetre: string, texte: string): void;
  chrome: { fenetreAgent(): Promise<string | null>; donnerAgent(fenetre: string): void };
  notifier(n: { titre: string; texte: string }): void;
  diffuser(): void;
}): DesignHost {
  // The batches of agent projects go in the space (the agent reads them); external projects' registries, review
  // repositories and batches go under <dataDir>/design, never mounted in the container.
  const dossiers = { remarquesEspace: join(o.chemins.interne, "remarques"), prive: join(o.dataDir, "design") };
  const remarques = new Remarques({ dossiers });
  let registre: RegistreExternes | null = null;
  let externes: ServiceExternes | null = null;
  let echec: string | null = null;

  // The batch sent to the agent: one pre-filled line in its session, never sent. The chrome reopens a window if needed
  // and design.donnerAgent brings it to the front.
  const envoiLot = async (p: ProjetSuivi, lot: Lot): Promise<void> => {
    if (p.type === "externe") return;
    const f = await o.chrome.fenetreAgent();
    await creerEnvoi({
      chemins: o.chemins,
      fenetreAgent: () => f ?? undefined,
      dossierLot: (pr, l) => remarques.dossierLot(pr, l),
      preRemplir: o.preRemplir,
      donnerLeTerminal: (w) => o.chrome.donnerAgent(w),
      devant: () => {},
    })(p, lot);
  };
  const review = new ReviewService({ dossiers, chemins: o.chemins, registre: () => registre, applis: o.applis, sites: o.sites, remarques, envoyer: envoiLot });

  // As index.ts:1163-1175: the apps with a manifest, then the site apps, each through the review's queue.
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
  const started = RegistreExternes.ouvrir(dossiers.prive)
    .then((r) => {
      registre = r;
      r.surChange(o.diffuser);
      // Never another port when this one is held.
      return demarrerExternes({
        registre: r,
        remarques,
        dossiers,
        port: o.port,
        plages: plagesConteneur(process.env.WEBAIOS_PORTS_APPS),
        // Stricter than Electron (the space root): nothing under the profile folder can be declared.
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
      echec = raisonEchec(e);
      o.diffuser();
    });

  const handlers: Record<(typeof DESIGN_METHODS)[number], (p: Params) => unknown> = {
    "externes.liste": (): EtatExternes =>
      externes?.etat() ?? { serveur: { etat: "eteint", raison: echec ?? "Le MCP externe démarre" }, projets: [], clients: [] },
    "externes.brancher": (p) => {
      const nom = checkClientName(p?.nom);
      if (!externes) throw new Error(echec ?? "Le MCP externe démarre");
      return externes.brancher(nom);
    },
    // A bad id does nothing, as ipc.ts.
    "externes.revoquer": async (p) => {
      if (typeof p?.id === "string" && CLIENT_ID.test(p.id)) await externes?.revoquer(p.id);
    },
    "externes.oublier": async (p) => {
      if (typeof p?.id !== "string" || !EXTERNAL_ID.test(p.id)) return;
      await externes?.oublier(p.id);
      review.oublier(`ext-${p.id}`);
    },
    "externes.nom": (p) => (typeof p?.id === "string" ? (registre?.projets().find((x) => x.id === p.id)?.nom ?? null) : null),
    "relecture.ouvrir": (p) => review.ouvrir(checkProject(p?.projet), p?.jeton === undefined || p.jeton === null ? undefined : checkToken(p.jeton)),
    "relecture.fichier": (p) => review.fichier(checkProject(p?.projet), checkToken(p?.jeton), checkPath(p?.chemin)),
    "relecture.lignes": (p) => {
      const projet = checkProject(p?.projet);
      const [debut, fin] = checkLines(p?.debut, p?.fin);
      return review.lignes(projet, checkToken(p?.jeton), checkPath(p?.chemin), debut, fin);
    },
    "relecture.commentaires": (p) => review.commentaires(checkProject(p?.projet)),
    "relecture.commenter": (p) => {
      const projet = checkProject(p?.projet);
      const c = p?.c;
      if (typeof c !== "object" || c === null) throw new Error("lignes invalides");
      const x = c as Record<string, unknown>;
      const [debut, fin] = checkLines(x.debut, x.fin);
      return review.commenter(projet, checkToken(p?.jeton), { fichier: checkPath(x.fichier), debut, fin, texte: checkText(x.texte) });
    },
    "relecture.modifierCommentaire": (p) => review.modifierCommentaire(checkProject(p?.projet), checkComment(p?.id), checkText(p?.texte)),
    "relecture.resoudre": (p) => {
      const projet = checkProject(p?.projet);
      const resolu = checkResolved(p?.resolu);
      return review.resoudre(projet, checkComment(p?.id), resolu);
    },
    "relecture.supprimerCommentaire": (p) => review.supprimerCommentaire(checkProject(p?.projet), checkComment(p?.id)),
    "relecture.envoyer": (p) => review.envoyer(checkProject(p?.projet)),
    "relecture.relu": (p) => review.relu(checkProject(p?.projet), checkToken(p?.jeton)),
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
