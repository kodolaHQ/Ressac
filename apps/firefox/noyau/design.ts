// The host side of design mode: remarks, the external MCP server and the review, started
// with the host and without the agent's noyau. Each RPC input is checked again with
// the shared guards (shared/design-guards.ts) before the service.
// The noyau is imported first: core/design/externes.ts and envoi.ts load under tsx only once it is linked.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  destinationDe, etatLot, PORT_MCP_EXTERNE, plagesConteneur, projetDemo, projetPourAdresse, projetPourFenetreApp, projetPourSite, RegistreExternes, Remarques,
  REMARQUE_VIDE, SANS_CLIENT, type Application, type CheminsEspace, type ContexteDesign, type Element, type IdProjet, type Lot, type ProjetSuivi,
} from "../../../packages/noyau/src/index.ts";
import { demarrerExternes, raisonEchec, type ServiceExternes } from "../core/design/externes.ts";
import { creerEnvoi } from "../core/design/envoi.ts";
import type { ElementAffiche, EtatExternes, LotAffiche, ResultatExtension } from "../shared/api.ts";
import { ReviewService } from "./review.ts";
import {
  checkCapture, checkClientName, checkComment, checkDesignContext, checkLines, checkPath, checkProject, checkResolved, checkText, checkToken, CLIENT_ID,
  DESIGN_ID_MAX, EXTERNAL_ID, ID_PROJECT, INVALID_REQUEST, REMARK_TEXT_MAX, URL_MAX,
} from "../shared/design-guards.ts";

/** The external MCP port: the asked one, else 5279; a bad value gives NaN, which the server refuses. */
export const externalMcpPort = (v: string | undefined): number => Number(v ?? PORT_MCP_EXTERNE);

// Copied from service.ts word for word (test/design-host.test.ts checks them): service.ts does not load under tsx.
export function sourceTexte(s: ContexteDesign["source"]): string | null {
  if (!s) return null;
  return s.ligne !== undefined ? `${s.fichier}:${s.ligne}` : s.fichier;
}

export function elementAffiche(e: Element): ElementAffiche {
  const base = { id: e.id, type: e.type, texte: e.texte, traite: e.traite ?? null };
  return e.type === "design"
    ? { ...base, etiquette: e.contexte.etiquette, source: sourceTexte(e.contexte.source) }
    : { ...base, etiquette: `${e.contexte.fichier}:${e.contexte.debut}-${e.contexte.fin}`, source: e.contexte.fichier };
}

export function lotAffiche(l: Lot): LotAffiche {
  return { id: l.id, cree: l.cree, etat: etatLot(l), destination: l.destination, elements: l.elements.map(elementAffiche) };
}

/** A followed project as the chrome shows it: its cart count, its destination, its name (ServiceDesign.etat). */
export interface SuiviDesign {
  projet: ProjetSuivi;
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
      echec = raisonEchec(e);
      o.diffuser();
    });

  // The design service's project logic: applis() is the running apps with a port.
  const running = async () => (await o.applis()).flatMap((a) => (a.etat === "en-marche" && a.port !== undefined ? [{ dossier: a.dossier, nom: a.nom, port: a.port }] : []));
  const projetSuivi = async (p: IdProjet): Promise<ProjetSuivi | null> => {
    if (p.startsWith("app-")) {
      const dossier = p.slice(4);
      return projetPourFenetreApp(dossier, (await running()).find((a) => a.dossier === dossier)?.nom ?? dossier);
    }
    if (p.startsWith("site-")) {
      const id = p.slice(5);
      const site = (await o.sites()).find((x) => x.id === id);
      return site ? projetPourSite(id, site.nom) : null;
    }
    if (p.startsWith("demo-")) return { type: "demo", projet: projetDemo(Number(p.slice(5))), port: Number(p.slice(5)) };
    const e = registre?.projets().find((x) => `ext-${x.id}` === p);
    return e ? { type: "externe", projet: p, dossier: e.dossier, nom: e.nom, client: e.client } : null;
  };
  const destination = (p: ProjetSuivi) => {
    const d = destinationDe(p, registre?.clients() ?? []);
    return "libelle" in d ? { destination: d.libelle, sansDestination: null } : { destination: null, sansDestination: d.indisponible };
  };
  const suivi = async (p: Params): Promise<SuiviDesign | null> => {
    let projet: ProjetSuivi | null;
    if (typeof p?.url === "string" && p.url.length <= URL_MAX)
      projet = projetPourAdresse(p.url, { appsLancees: await running(), plages: plagesConteneur(process.env.WEBAIOS_PORTS_APPS), externes: registre?.projets() ?? [] });
    else if (p?.url === undefined && p?.projet !== undefined) projet = await projetSuivi(checkProject(p.projet));
    else throw new Error(INVALID_REQUEST);
    if (!projet) return null;
    const panier = (await remarques.panier(projet.projet)).length;
    return { projet, panier, ...destination(projet), nom: projet.type === "demo" ? `localhost:${projet.port}` : projet.nom };
  };
  const erreur = (e: unknown): ResultatExtension => ({ ok: false, erreur: e instanceof Error ? e.message : String(e) });
  const ajouter = async (p: Params): Promise<ResultatExtension> => {
    let projet: IdProjet, contexte: ContexteDesign, capture: Buffer | null;
    const texte = p?.texte;
    try {
      if (typeof texte !== "string" || texte.length > REMARK_TEXT_MAX) throw new Error(INVALID_REQUEST);
      projet = checkProject(p?.projet);
      contexte = checkDesignContext(p?.contexte);
      capture = checkCapture(p?.capture);
      // A forgotten external project gets no cart.
      if (!(await projetSuivi(projet))) throw new Error(INVALID_REQUEST);
    } catch {
      return { ok: false, erreur: INVALID_REQUEST };
    }
    if (texte.trim() === "") return { ok: false, erreur: REMARQUE_VIDE };
    try {
      await remarques.ajouterAuPanier(projet, { texte, contexte, capture });
      return { ok: true };
    } catch (e) {
      return erreur(e);
    }
  };
  // The design service's send, with a site snapshot before the first batch.
  const envoyer = async (p: Params): Promise<ResultatExtension> => {
    if (!projetId(p?.projet)) return { ok: false, erreur: INVALID_REQUEST };
    const projet = await projetSuivi(p.projet);
    if (!projet) return { ok: false, erreur: SANS_CLIENT };
    let dest: { destination: "agent" | "mcp"; client?: string } = { destination: "agent" };
    if (projet.type === "externe") {
      const d = destinationDe(projet, registre?.clients() ?? []);
      if ("indisponible" in d || projet.client === null) return { ok: false, erreur: SANS_CLIENT };
      dest = { destination: "mcp", client: projet.client };
    }
    try {
      const lot = await remarques.envoyerPanier(projet.projet, dest);
      if (projet.type === "site") await review.assurer(projet.projet).catch(() => undefined);
      await envoiLot(projet, lot);
      return { ok: true };
    } catch (e) {
      return erreur(e);
    }
  };
  const id = (v: unknown): v is string => typeof v === "string" && v.length <= DESIGN_ID_MAX;
  const projetId = (v: unknown): v is IdProjet => typeof v === "string" && ID_PROJECT.test(v);

  const handlers: Record<(typeof DESIGN_METHODS)[number], (p: Params) => unknown> = {
    "externes.liste": (): EtatExternes =>
      externes?.etat() ?? { serveur: { etat: "eteint", raison: echec ?? "Le MCP externe démarre" }, projets: [], clients: [] },
    "externes.brancher": (p) => {
      const nom = checkClientName(p?.nom);
      if (!externes) throw new Error(echec ?? "Le MCP externe démarre");
      return externes.brancher(nom);
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
    "design.suivi": suivi,
    "design.ajouter": ajouter,
    // A bad project or id answers an empty list, or nothing.
    "design.panier": async (p) => (projetId(p?.projet) ? (await remarques.panier(p.projet)).map(elementAffiche) : []),
    "design.lots": async (p) => (projetId(p?.projet) ? (await remarques.lots(p.projet)).map(lotAffiche) : []),
    "design.retirer": async (p) => {
      if (projetId(p?.projet) && id(p?.id)) await remarques.retirerDuPanier(p.projet, p.id);
    },
    "design.traite": async (p) => {
      if (projetId(p?.projet) && id(p?.lot)) await remarques.marquerLotTraite(p.projet, p.lot);
    },
    "design.envoyer": envoyer,
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
