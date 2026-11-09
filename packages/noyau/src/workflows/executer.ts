import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { DELAI_RECOLTE_S, type Atelier } from "../conteneur/atelier.js";
import { cheminOutils } from "../conteneur/executeur.js";
import type { IaLocale } from "../ia/ia-locale.js";
import { ProfilRefuse, type PontNavigateur } from "../mcp/pont.js";
import {
  MAX_LECTURES_OUVERTES,
  MAX_RECHERCHES,
  PLAFOND_RECHERCHES,
  RECHERCHE_INDISPONIBLE,
  RECHERCHES_ARRETEES,
  TROP_DE_LECTURES,
  adresseLocale,
  message,
  recuperer,
  tronquer,
  verifierPage,
  verifierUrl,
} from "./acces.js";
import { RECHERCHE_REFUSEE, RESULTATS_ILLISIBLES, URL_DUCKDUCKGO, extraireResultats, urlRecherche } from "./duckduckgo.js";
import { chaineAuFilDeLEau } from "./chaine.js";
import { Menagement, type ChangerHote } from "./menagement.js";
import { ACTION_ARRETEE, SORTIE_MAX_OCTETS, coupe, idExecution, type Execution, type TraceBloc } from "./executions.js";
import { MEMOIRE_MAX_OCTETS, empreinteParametres, type MemoireBlocs } from "./memoire.js";
import {
  ArgsChercherWeb,
  ArgsGemma,
  ArgsKev,
  ArgsLirePage,
  ArgsRecuperer,
  LIGNE_MAX_OCTETS,
  TAILLE_MAX_DONNEES,
  ligneDebut,
  ligneMemoire,
  ligneReponse,
  lireMessageRecolteur,
  type MessageRecolteur,
} from "./protocole.js";
import { REJEU_TROP_GROS } from "./rejeu.js";
import type { GenreSortie, Proprietaire } from "./schema.js";
import { WEB_REQUIS, type WorkflowValide } from "./valider.js";

/** The run's process (the `docker run -i` client): its only channel with the kernel is stdin / stdout. */
export interface ProcessusRecolte {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  tuer(): void;
  /** Exit code; null if killed by a signal or impossible to launch. */
  fin: Promise<number | null>;
}
export type LanceurProcessus = (cmd: string, args: string[]) => ProcessusRecolte;

export const lancerParDefaut: LanceurProcessus = (cmd, args) => {
  const enfant = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: cheminOutils() } });
  const fin = new Promise<number | null>((ok) => {
    enfant.once("close", (code) => ok(code));
    enfant.once("error", () => ok(null));
  });
  return { stdin: enfant.stdin, stdout: enfant.stdout, stderr: enfant.stderr, tuer: () => void enfant.kill("SIGKILL"), fin };
};

/** Kernel-side timeout; the container stops by itself after 180 s (+5 s). */
export const DELAI_EXECUTION_MS = 200_000;

// Copied into the container's interpreter (docker/moteur/interpreteur.mjs): a test checks that they agree.
/** Gap between two as-it-goes publications. */
export const ECART_PUBLICATIONS_MS = 5000;
/** Gap between two sends of the memory along the way (progressive run). */
export const ECART_MEMOIRE_MS = 30_000;
/**
 * A publication that arrives less than 4 s after the previous relayed one is ignored: the container spaces them 5 s apart on
 * its clock, the margin covers the gap between the two clocks and the transport time.
 */
const ECART_PUBLICATIONS_TOLERE_MS = ECART_PUBLICATIONS_MS - 1000;
/** Action: gap between two `avancement` lines of the same block (the last one, `faits = total`, always goes). */
export const ECART_AVANCEMENT_MS = 1000;
/**
 * An `avancement` line that arrives less than 500 ms after the previous relayed one of the same block is ignored (except the last):
 * the margin covers the gap between the clocks and the transport time, code that wrote them constantly is bounded.
 */
const ECART_AVANCEMENT_TOLERE_MS = ECART_AVANCEMENT_MS / 2;
/** The host announced by the `lecture` trace of a web search. */
const HOTE_RECHERCHE = "duckduckgo.com";

/**
 * The delays of a run. Without `dureeMaxMinutes`: today's (container 180 s, kernel 200 s, no limit
 * sent: the interpreter keeps its 150 s). With D minutes: no item run after D × 60 s, container stopped
 * at D × 60 + 30 s, kernel at D × 60 + 50 s.
 */
export function delaisExecution(dureeMaxMinutes: number | undefined): { conteneurS: number; noyauMs: number; limiteMs?: number } {
  if (dureeMaxMinutes === undefined) return { conteneurS: DELAI_RECOLTE_S, noyauMs: DELAI_EXECUTION_MS };
  return { conteneurS: dureeMaxMinutes * 60 + 30, noyauMs: dureeMaxMinutes * 60_000 + 50_000, limiteMs: dureeMaxMinutes * 60_000 };
}

export const PROFIL_REFUSE =
  "Le profil de connexion choisi n'est plus utilisable (supprimé ou utilisé par un espace privé) : accord à redonner";

const MAX_APPELS_EN_VOL = 32;
/**
 * Effective kernel caps: an error (run, block, call) at 500 characters, the global log at 2000.
 * Those of the container (2000 characters per trace) and of the runs' write (2 KB per line) are only safety nets.
 */
export const JOURNAL_MAX = 2000;
export const ERREUR_MAX = 500;
/** Kernel remark when the returned blocks' memory is too big for its file. */
export const MEMOIRE_NON_GARDEE = "Mémoire des blocs non gardée : plus de 3 Mo (l'ancienne reste)";
const JOURNAL_BLOC_LIGNES = 200;
const JOURNAL_BLOC_CARACTERES = 500;

export interface ContexteWorkflow {
  proprietaire: Proprietaire;
  valide: WorkflowValide;
  /** Folder of the owner's files (`.mjs` of the `code` blocks), mounted read-only on `/widget`. */
  dossierFichiers: string;
  config: unknown;
  precedent: unknown;
  memoire: MemoireBlocs;
  /**
   * Domains read with the user's account, and public domains allowed when there are some with an account. `web`: web searches
   * allowed and paced open reads (never with an account).
   */
  sources: { compte: readonly string[]; publiques: readonly string[]; web?: boolean };
  /** Re-read at each read with an account; null = grant gone. */
  accord(): Promise<{ profil: string } | null>;
  /** The browser refuses the grant's profile (deleted, became private). */
  surProfilRefuse(): Promise<void>;
  messageAccordRequis: string;
  declencheur: Execution["declencheur"];
  /**
   * A builder try (plan of `planRejeu`): only the `relances` blocks run, with the `sorties` taken
   * from the original run; no memory sent or kept. `repris`: the taken blocks and their number of items.
   */
  rejeu?: { relances: string[]; sorties: Record<string, unknown>; repris: Record<string, number | null> };
  /** The widget's `recolte.dureeMaxMinutes`: sets the delays and makes the run progressive (except a try). */
  dureeMaxMinutes?: number;
  /** Action only: the text typed at launch, sent in `debut` and copied into the run. */
  saisie?: string;
  /** Action only: the per-item blocks send their progress (relayed as an `avancement` trace). */
  avancement?: true;
  /** Action only: raised, the run is stopped (container killed) and concludes « interrompue » (ACTION_ARRETEE). */
  signal?: AbortSignal;
}

/** An as-it-goes publication: the items already finished, `faits` out of `total`. */
export type Publication = { donnees: unknown; faits: number; total: number };

/**
 * An accepted trace (in order), relayed live to the builder. `avancement`: coming from the container (action
 * only); `lecture`: emitted by the kernel at each accepted read, attached to the last block started and not finished.
 */
export type TraceDirecte =
  | { bloc: string; etape: "debut" }
  | { bloc: string; etape: "fin"; statut: "reussi" | "partiel" | "echoue"; elements: number | null }
  | { bloc: string; etape: "avancement"; faits: number; total: number }
  | { bloc: string; etape: "lecture"; hote: string };

export interface InfraWorkflow {
  /** Folder of the engine on the Mac (`docker/moteur`), mounted read-only. */
  moteur: string;
  atelier: Pick<Atelier, "commandeRecolte" | "supprimerRecolte">;
  lancer?: LanceurProcessus;
  /** null: no local AI, `kev` and `gemma` answer with an error. */
  ia: Pick<IaLocale, "kev" | "gemma"> | null;
  pont: PontNavigateur;
  horloge: () => Date;
  delaiMs?: number;
  /** Tests only: allows `recuperer` and `lirePage` to local addresses (127.0.0.1…). */
  adressesLocales?: boolean;
  /** Pacing of the searches and open reads (default: MENAGEMENT_PAR_DEFAUT, shared). */
  menagement?: Menagement;
  /** Tests only: the base of the DuckDuckGo searches. */
  urlRecherche?: string;
  /** Called for each accepted trace (never for a rejected line); an error from the relay is ignored. */
  surTrace?: (t: TraceDirecte) => void;
  /**
   * An as-it-goes chain publication (see `executerWorkflow`). The relays (publications and memory) are
   * done one after the other and all finished before the run returns; an error from a relay is ignored.
   */
  surPublication?: (p: Publication) => Promise<void>;
  /** Progressive run only: the memory received along the way, at most every ECART_MEMOIRE_MS. */
  surMemoire?: (m: MemoireBlocs) => Promise<void>;
}

export type IssueWorkflow =
  | { t: "fin"; sortie: { vers: GenreSortie; valeur: unknown }; memoire: MemoireBlocs | null }
  /**
   * `erreurDuCode`: the text comes from the container (the agent's code may have written it), not from the kernel. `memoire` (progressive
   * run only, absent otherwise): the last memory received, null if none.
   */
  | { t: "echec"; erreur: string; erreurDuCode: boolean; memoire?: MemoireBlocs | null }
  /** Stopped by the kernel (delay, grant, profile refused, answer too big…): the text is the kernel's. `memoire`: same. */
  | { t: "arret"; statut: "erreur" | "accord-requis"; erreur: string; memoire?: MemoireBlocs | null };

function args<T>(schema: { safeParse(x: unknown): { success: true; data: T } | { success: false } }, a: unknown, f: string): T {
  const r = schema.safeParse(a);
  if (!r.success) throw new Error(`Arguments invalides pour ${f}`);
  return r.data;
}

/** The pacing shared by all the kernel's runs, when the caller gives none. */
export const MENAGEMENT_PAR_DEFAUT = new Menagement();

type Arret = { statut: "erreur" | "accord-requis"; erreur: string };
/** The run is stopped: the call receives no answer. */
const SANS_REPONSE = Symbol("sans réponse");

/** Trace of a block during the run, with what is needed to bound its log. */
type TraceEnCours = TraceBloc & { commence: boolean; fini: boolean; coupees: number };

/**
 * Runs a validated workflow in a container without network: sends `debut` (workflow, config, previous) and the
 * blocks' memory, answers the calls (lirePage, recuperer, kev, gemma) with the rules of the sources and of the grant,
 * stores the blocks' traces. Writes nothing: the caller decides what is kept (privacy).
 *
 * Progressive run (not a try, with `dureeMaxMinutes` or an as-it-goes output): the memory received along the
 * way is relayed (`surMemoire`) and the last one comes back with a failure or a stop. A `publication` line is only
 * relayed (`surPublication`) during the as-it-goes chain (between the last `debut` and the first `fin` of
 * its blocks), at least 4 s after the previous relayed one, with `faits ≤ total` and data of 2 MB at most: a
 * publication written by the agent's code outside the chain, or late, cannot overwrite the final output.
 */
export async function executerWorkflow(
  ctx: ContexteWorkflow,
  infra: InfraWorkflow,
): Promise<{ issue: IssueWorkflow; execution: Execution; journal: string }> {
  const horloge = infra.horloge;
  const adressesLocales = infra.adressesLocales ?? false;
  const debut = horloge().toISOString();
  const { workflow, ordre } = ctx.valide;
  const rejeu = ctx.rejeu ?? null;
  // For a try, only the rerun blocks send traces, in run order.
  const relances = rejeu ? new Set(rejeu.relances) : null;
  const attendu = relances ? ordre.filter((id) => relances.has(id)) : ordre;
  const types = new Map(workflow.blocs.map((b) => [b.id, b.type]));
  const auFilDeLEau = workflow.blocs.find((b) => b.id === ctx.valide.sortie.id)?.parametres.auFilDeLEau === true;
  const progressif = !rejeu && (ctx.dureeMaxMinutes !== undefined || auFilDeLEau);
  // A try has no chain: it runs block by block and publishes nothing.
  const chaine = rejeu ? [] : chaineAuFilDeLEau(ctx.valide);
  const delais = delaisExecution(ctx.dureeMaxMinutes);
  // The validated params of this run: the memory is only taken back if it was kept with the same ones.
  const empreintes = new Map(workflow.blocs.map((b) => [b.id, empreinteParametres(b.parametres)]));
  const traces = new Map<string, TraceEnCours>(
    ordre.map((id) => [
      id,
      { id, type: types.get(id)!, statut: "pas-lance", debut: null, fin: null, elements: null, journal: [], commence: false, fini: false, coupees: 0 },
    ]),
  );
  if (rejeu) {
    for (const [id, elements] of Object.entries(rejeu.repris)) {
      const t = traces.get(id);
      if (t && !relances!.has(id)) Object.assign(t, { statut: "repris", elements });
    }
  }
  let journal = "";
  let remarque: string | null = null;
  // Stopped by the caller's signal (an action's « Arrêter »): the run is « interrompue ».
  let arreteeParSignal = false;

  const conclure = (issue: IssueWorkflow) => {
    const blocs: TraceBloc[] = [...traces.values()].map(({ commence, fini, coupees, ...t }) => {
      const b: TraceBloc = { ...t };
      // Started without an end: the container stopped during the block (or was stopped on request).
      if (commence && !fini) b.statut = arreteeParSignal ? "interrompu" : "echoue";
      if (coupees > 0) b.journal = [`… ${coupees} lignes coupées`, ...t.journal];
      return b;
    });
    const statut: Execution["statut"] =
      issue.t === "fin"
        ? // A partial block, or one that did not finish (a `fin` that arrived before it): the output is not complete. For a
          // try, only the rerun blocks count.
          blocs.every((b) => b.statut === "reussi" || (relances !== null && !relances.has(b.id))) ? "reussie" : "partielle"
        : issue.t === "arret" && issue.statut === "accord-requis"
          ? "accord-requis"
          : issue.t === "arret" && arreteeParSignal
            ? "interrompue"
            : "echouee";
    const execution: Execution = {
      version: 1,
      id: idExecution(debut),
      proprietaire: ctx.proprietaire,
      declencheur: ctx.declencheur,
      debut,
      fin: horloge().toISOString(),
      statut,
      blocs,
    };
    if (ctx.saisie !== undefined) execution.saisie = ctx.saisie;
    if (issue.t !== "fin") {
      execution.erreur = issue.erreur;
      if (issue.t === "arret" || !issue.erreurDuCode) execution.erreurNoyau = true;
    }
    if (remarque) {
      journal = (journal ? journal + "\n" : "") + remarque;
      // Also in the run, in the output block's log.
      blocs.find((b) => b.id === ctx.valide.sortie.id)?.journal.push(remarque);
    }
    return { issue, execution, journal: journal.slice(-JOURNAL_MAX) };
  };
  const echec = (erreur: string, erreurDuCode: boolean): IssueWorkflow => ({ t: "echec", erreur: tronquer(erreur, ERREUR_MAX), erreurDuCode });

  // For an owner with an account, public reads are limited to the declared domains (empty: none).
  const aCompte = ctx.sources.compte.length > 0;
  const domainesPublics = aCompte ? ctx.sources.publiques : null;
  // Paced web searches and open reads: only for a widget that declares `web`, never with an account.
  const web = ctx.sources.web === true && !aCompte;
  const menagement = infra.menagement ?? MENAGEMENT_PAR_DEFAUT;
  // Raised at the stop or the end: a search or read still in the queue does not go out, and those in progress (bridge,
  // fetch) are abandoned. Specific to this run: the other runs' reads are not touched.
  const finExecution = new AbortController();
  let recherches = 0;
  let rechercheRefusee = false;
  let lecturesOuvertes = 0;

  const debutLigne = ligneDebut({
    precedent: ctx.precedent,
    maintenant: debut,
    config: ctx.config ?? null,
    workflow: { blocs: workflow.blocs, liens: workflow.liens, ordre },
    ...(rejeu ? { rejeu: { relances: rejeu.relances, sorties: rejeu.sorties } } : {}),
    ...(delais.limiteMs !== undefined ? { limiteMs: delais.limiteMs } : {}),
    ...(progressif ? { progressif: true as const } : {}),
    ...(ctx.saisie !== undefined ? { saisie: ctx.saisie } : {}),
    ...(ctx.avancement ? { avancement: true as const } : {}),
  });
  // Safety net: the caller measures before (`debutTropGros`) to refuse without writing anything; the harvester would refuse the line.
  if (rejeu && Buffer.byteLength(debutLigne) > LIGNE_MAX_OCTETS) {
    return conclure({ t: "arret", statut: "erreur", erreur: REJEU_TROP_GROS });
  }

  // A container of the same name left by an abrupt stop would make `docker run` fail (125); the queues only launch
  // one per owner, so this one can only be a leftover. Before the signal test, perhaps raised meanwhile.
  await infra.atelier.supprimerRecolte(ctx.proprietaire).catch(() => {});
  // Stopped before even leaving: nothing is launched.
  if (ctx.signal?.aborted) {
    arreteeParSignal = true;
    return conclure({ t: "arret", statut: "erreur", erreur: ACTION_ARRETEE });
  }

  let processus: ProcessusRecolte;
  try {
    const [cmd, ...argv] = infra.atelier.commandeRecolte(ctx.proprietaire, ctx.dossierFichiers, infra.moteur, delais.conteneurS);
    processus = (infra.lancer ?? lancerParDefaut)(cmd!, argv);
  } catch (e) {
    return conclure({ t: "arret", statut: "erreur", erreur: `Récolte impossible à lancer : ${message(e)}` });
  }

  let arret: Arret | null = null;
  let terminal: Extract<MessageRecolteur, { t: "fin" | "echec" }> | null = null;
  let memoireRecue: MemoireBlocs | null = null;
  let enVol = 0;
  // Relays to the caller (publications, memory), one after the other; all awaited before returning.
  let relais: Promise<void> = Promise.resolve();
  const enFile = (f: () => Promise<void>) => {
    relais = relais.then(f).catch(() => {});
  };
  let memoireRelayeeA: number | null = null;
  // Progressive run: the container resolves the keys of the items a publication will show, sends `memoire`,
  // then `publication`. If the kernel rejects this publication, these items were never shown: the memory must
  // stay the one from before (R34). A memory is therefore held until the next line:
  // - an accepted publication makes it safe; rejected, it is discarded, and so are the following memories (they
  //   still keep these keys) until the next accepted publication, which shows all the items again;
  // - another line (trace, call, echec, fin…) makes it safe: it did not precede a publication;
  // - nothing after (stop, container killed): discarded, it may have preceded a publication never read.
  // `memoireSure` is that of a failure or a stop and of the `surMemoire` relays; an end keeps the last one received
  // (`memoireRecue`), because the output shows everything.
  let memoireSure: MemoireBlocs | null = null;
  let memoireTenue: { memoire: MemoireBlocs | null; recueA: number } | null = null;
  let memoireDouteuse = false;
  // The output block's `fin` trace has passed: a memory received afterwards (verifierMemoire, just before `fin`) has
  // resolved all the pending keys, which only the final output shows. It is only used for the `fin` outcome
  // (`memoireRecue`), never relayed or safe: if the final data is refused, the previous safe memory stays.
  let sortieFinie = false;
  // Adoption happens in the relay queue, after the publications received before it: a memory is only safe
  // if the data it assumes shown has really been written (F1).
  const adopterDansLaFile = async (t: { memoire: MemoireBlocs | null; recueA: number }) => {
    if (!t.memoire || memoireDouteuse) return;
    const memoire = t.memoire;
    memoireSure = memoire;
    const surMemoire = infra.surMemoire;
    if (surMemoire && (memoireRelayeeA === null || t.recueA - memoireRelayeeA >= ECART_MEMOIRE_MS)) {
      memoireRelayeeA = t.recueA;
      await surMemoire(memoire);
    }
  };
  const adopterMemoire = (t: { memoire: MemoireBlocs | null; recueA: number }) => enFile(() => adopterDansLaFile(t));
  const libererMemoireTenue = () => {
    const t = memoireTenue;
    memoireTenue = null;
    if (t) adopterMemoire(t);
  };
  let publicationRelayeeA: number | null = null;
  const arreter = (a: Arret) => {
    if (arret) return;
    arret = a;
    finExecution.abort(new Error("Exécution arrêtée"));
    processus.tuer();
  };
  const minuteur = setTimeout(() => arreter({ statut: "erreur", erreur: "Délai dépassé" }), infra.delaiMs ?? delais.noyauMs);
  const surSignal = () => {
    if (arret) return;
    arreteeParSignal = true;
    arreter({ statut: "erreur", erreur: ACTION_ARRETEE });
  };
  ctx.signal?.addEventListener("abort", surSignal, { once: true });

  processus.stdin.on("error", () => {});
  processus.stdin.write(debutLigne);
  // Only the memory of this workflow's blocks, with their type; none for a try.
  processus.stdin.write(ligneMemoire(rejeu ? {} : reprendreMemoire(ctx.memoire, types, empreintes)));
  processus.stderr.setEncoding("utf8");
  processus.stderr.on("data", (d: string) => {
    journal = (journal + d).slice(-JOURNAL_MAX);
  });

  const repondre = (n: number, r: { ok: unknown } | { erreur: string }) => {
    if (arret || terminal || processus.stdin.destroyed || processus.stdin.writableEnded) return;
    let ligne = ligneReponse(n, r);
    if (Buffer.byteLength(ligne) > LIGNE_MAX_OCTETS) ligne = ligneReponse(n, { erreur: "Réponse trop grande (4 Mo maximum)" });
    processus.stdin.write(ligne);
  };

  /** Read options: for an owner with an account, the bridge receives the list of domains where it may navigate. */
  // Tests only: the bridge then also allows local addresses (it refuses them otherwise, redirects included).
  const avecDomaines = (profil: string | null, domaines: readonly string[] | null) => ({
    profil,
    ...(aCompte && domaines ? { domaines: [...domaines] } : {}),
    ...(adressesLocales ? { adressesLocales: true } : {}),
    signal: finExecution.signal,
  });

  /**
   * An open read (page without account, fetch, feed): for a `web` widget, counted (100 per run) and
   * paced per host, redirects to another site included (`changerHote`); otherwise, done right away as before.
   */
  const lectureOuverte = <T>(u: URL, f: (changerHote?: ChangerHote) => Promise<T>): Promise<T> => {
    if (!web) return f();
    if (lecturesOuvertes >= MAX_LECTURES_OUVERTES) throw new Error(TROP_DE_LECTURES);
    lecturesOuvertes++;
    return menagement.lire(u.hostname, f, finExecution.signal);
  };

  const lirePage = async (a: unknown): Promise<unknown> => {
    const { url, compte, defiler } = args(ArgsLirePage, a, "lirePage");
    const defilement = defiler ? { defiler } : {};
    const lire = infra.pont.lirePageInvisible?.bind(infra.pont);
    if (!lire) throw new Error("Lecture de pages indisponible");
    if (!compte) {
      const u = verifierUrl(url, domainesPublics, adressesLocales);
      signalerLecture(u);
      const page = await lectureOuverte(u, (changerHote) => lire(u.href, { ...avecDomaines(null, domainesPublics), ...defilement, ...(changerHote ? { changerHote } : {}) }));
      return verifierPage(page, domainesPublics, adressesLocales);
    }
    // The domain must be declared in `compte`; the grant is re-read at each read (it may have been withdrawn).
    const u = verifierUrl(url, ctx.sources.compte, adressesLocales);
    const accord = await ctx.accord();
    if (!accord) {
      arreter({ statut: "accord-requis", erreur: ctx.messageAccordRequis });
      return SANS_REPONSE;
    }
    if (arret) return SANS_REPONSE;
    signalerLecture(u);
    try {
      const page = await lire(u.href, { ...avecDomaines(accord.profil, ctx.sources.compte), ...defilement });
      return verifierPage(page, ctx.sources.compte, adressesLocales);
    } catch (e) {
      if (e instanceof ProfilRefuse || (e as Error)?.name === "ProfilRefuse") {
        // The caller withdraws the grant (and what was read with it) before the stop: when it concludes, it no longer exists.
        try {
          await ctx.surProfilRefuse();
        } finally {
          arreter({ statut: "accord-requis", erreur: PROFIL_REFUSE });
        }
        return SANS_REPONSE;
      }
      throw e;
    }
  };

  const chercherWeb = async (a: unknown): Promise<unknown> => {
    const { requete, nombre } = args(ArgsChercherWeb, a, "chercherWeb");
    // Refused here even if the validation let it through: a `code` block or a recolte.mjs may call chercherWeb.
    if (!web) throw new Error(WEB_REQUIS);
    if (rechercheRefusee) throw new Error(RECHERCHES_ARRETEES);
    if (recherches >= MAX_RECHERCHES) throw new Error(PLAFOND_RECHERCHES);
    const lireHtml = infra.pont.lireHtmlInvisible?.bind(infra.pont);
    if (!lireHtml) throw new Error(RECHERCHE_INDISPONIBLE);
    recherches++;
    signalerLecture(HOTE_RECHERCHE);
    const r = await menagement.rechercher(
      async () => {
        const { html } = await lireHtml(urlRecherche(requete, infra.urlRecherche ?? URL_DUCKDUCKGO), {
          ...(adressesLocales ? { adressesLocales: true } : {}),
          signal: finExecution.signal,
        });
        const lus = extraireResultats(html, Infinity);
        // Marked before releasing the lane: a queued search sees the refusal before going out.
        if ("refus" in lus) rechercheRefusee = true;
        return lus;
      },
      finExecution.signal,
      // A refusal that arrived during the wait: this one does not go out, and does not delay the next search.
      () => {
        if (rechercheRefusee) throw new Error(RECHERCHES_ARRETEES);
      },
    );
    if ("refus" in r) throw new Error(RECHERCHE_REFUSEE);
    if ("illisible" in r) throw new Error(RESULTATS_ILLISIBLES);
    // A result toward the machine or the local network is never returned (it would be read afterwards).
    return r.resultats.filter((x) => !adresseLocale(new URL(x.url).hostname)).slice(0, nombre);
  };

  const traiterAppel = async (f: string, a: unknown): Promise<unknown> => {
    switch (f) {
      case "lirePage":
        return lirePage(a);
      case "recuperer": {
        const { url, format } = args(ArgsRecuperer, a, "recuperer");
        const u = verifierUrl(url, domainesPublics, adressesLocales);
        signalerLecture(u);
        if (!web) return recuperer(url, format ?? "texte", domainesPublics, adressesLocales, finExecution.signal);
        return lectureOuverte(u, (changerHote) => recuperer(u.href, format ?? "texte", domainesPublics, adressesLocales, finExecution.signal, changerHote));
      }
      case "chercherWeb":
        return chercherWeb(a);
      case "kev": {
        const corps = args(ArgsKev, a, "kev");
        if (!infra.ia) throw new Error("IA locale indisponible");
        // Stop or delay: the in-flight call is abandoned and gives its place back to the shared AI.
        return infra.ia.kev(corps, { signal: finExecution.signal });
      }
      case "gemma": {
        const g = args(ArgsGemma, a, "gemma");
        if (!infra.ia) throw new Error("IA locale indisponible");
        return infra.ia.gemma({ ...g, signal: finExecution.signal });
      }
      default:
        throw new Error(`Fonction inconnue : ${f}`);
    }
  };

  // The traces come from the container, where the agent's code runs: it may write fake ones on stdout. Only
  // those of this workflow's blocks count, in run order (one block at a time), in the protocol's format.
  // For a try, only the rerun blocks: a line for a taken or non-rerun block is rejected. Only exception:
  // the as-it-goes chain, whose blocks all start in a row then finish in order.
  let suivant = 0;
  /** Blocks started and not yet finished, in order: a single one, or the chain's blocks. */
  const ouverts: TraceEnCours[] = [];
  /** An end of the chain has arrived: no more starts accepted until its blocks have all finished. */
  let fermeture = false;
  /** Between the last `debut` and the first `fin` of the chain: the only moment a publication counts. */
  const pendantLaChaine = () => chaine.length > 0 && !fermeture && ouverts.length === chaine.length && ouverts[0]!.id === chaine[0];
  const relayer = (t: TraceDirecte) => {
    try {
      infra.surTrace?.(t);
    } catch {
      // The live relay never stops the run.
    }
  };
  /** An accepted read (URL host, or that of the web search), on the last block started and not finished. */
  function signalerLecture(cible: URL | string) {
    const bloc = ouverts.at(-1);
    const hote = typeof cible === "string" ? cible : cible.hostname.toLowerCase().replace(/\.+$/, "");
    if (bloc) relayer({ bloc: bloc.id, etape: "lecture", hote });
  }
  /** Per block: the time of the last relayed `avancement` line. */
  const avancementRelayeA = new Map<string, number>();
  const traiterTrace = (m: Exclude<MessageRecolteur, { t: "appel" | "fin" | "echec" }>) => {
    if (m.t === "memoire") {
      // A try keeps no memory: what the container says about it is ignored.
      if (rejeu) return;
      const filtree = marquerMemoire(m.memoire as MemoireBlocs, types, empreintes);
      const tropGrosse = Buffer.byteLength(JSON.stringify({ version: 1, blocs: filtree })) > MEMOIRE_MAX_OCTETS;
      memoireRecue = tropGrosse ? null : filtree;
      remarque = tropGrosse ? MEMOIRE_NON_GARDEE : null;
      if (progressif && !sortieFinie) memoireTenue = { memoire: tropGrosse ? null : filtree, recueA: horloge().getTime() };
      return;
    }
    if (m.t === "publication") {
      const tenue = memoireTenue;
      memoireTenue = null;
      const maintenant = horloge().getTime();
      const surPublication = infra.surPublication;
      const acceptee =
        pendantLaChaine() &&
        m.faits <= m.total &&
        m.donnees !== undefined &&
        (publicationRelayeeA === null || maintenant - publicationRelayeeA >= ECART_PUBLICATIONS_TOLERE_MS) &&
        Buffer.byteLength(JSON.stringify(m.donnees)) <= TAILLE_MAX_DONNEES &&
        surPublication !== undefined;
      if (!acceptee) {
        // The container believes these items shown: its memory is no longer safe before the next accepted publication.
        if (progressif && (tenue || pendantLaChaine())) {
          enFile(async () => {
            memoireDouteuse = true;
          });
        }
        return;
      }
      publicationRelayeeA = maintenant;
      const p: Publication = { donnees: m.donnees, faits: m.faits, total: m.total };
      // The data first, then the memory they make safe; a refused write leaves it doubtful.
      enFile(async () => {
        try {
          await surPublication!(p);
        } catch {
          memoireDouteuse = true;
          return;
        }
        memoireDouteuse = false;
        if (tenue) await adopterDansLaFile(tenue);
      });
      return;
    }
    if (m.t === "journal") {
      const t = traces.get(m.bloc);
      if (!t || (relances && !relances.has(m.bloc))) return;
      t.journal.push(tronquer(m.texte, JOURNAL_BLOC_CARACTERES));
      // The room for the « … N lignes coupées » line is kept: 200 lines at most in all.
      while (t.journal.length + (t.coupees > 0 ? 1 : 0) > JOURNAL_BLOC_LIGNES) {
        t.journal.shift();
        t.coupees++;
      }
      return;
    }
    const t = traces.get(m.id);
    if (!t) return;
    if (m.etape === "avancement") {
      // Only if the caller asked for it, for a block in progress, spaced out (the last one always).
      if (!ctx.avancement || !ouverts.includes(t)) return;
      const maintenant = horloge().getTime();
      const avant = avancementRelayeA.get(m.id);
      if (m.faits < m.total && avant !== undefined && maintenant - avant < ECART_AVANCEMENT_TOLERE_MS) return;
      avancementRelayeA.set(m.id, maintenant);
      relayer({ bloc: m.id, etape: "avancement", faits: m.faits, total: m.total });
      return;
    }
    if (m.etape === "debut") {
      if (attendu[suivant] !== m.id) return;
      // A block already open: only the chain's next block can start, before any end.
      if (ouverts.length > 0 && (fermeture || ouverts[0]!.id !== chaine[0] || chaine[ouverts.length] !== m.id)) return;
      suivant++;
      t.commence = true;
      t.debut = horloge().toISOString();
      ouverts.push(t);
      relayer({ bloc: m.id, etape: "debut" });
      return;
    }
    if (ouverts[0] !== t) return;
    ouverts.shift();
    fermeture = ouverts.length > 0;
    t.fini = true;
    if (t.id === ctx.valide.sortie.id) sortieFinie = true;
    t.fin = horloge().toISOString();
    t.statut = m.statut;
    if (m.erreur !== undefined) t.erreur = tronquer(m.erreur, ERREUR_MAX);
    if (m.sortieTropGrosse) t.sortieTronquee = true;
    else if (m.sortie !== undefined) {
      t.elements = Array.isArray(m.sortie) ? m.sortie.length : null;
      // The kernel never keeps more than 256 KB of a block's output: beyond, the start of its JSON, marked.
      const texte = JSON.stringify(m.sortie);
      if (Buffer.byteLength(texte) > SORTIE_MAX_OCTETS) {
        t.sortie = coupe(texte, SORTIE_MAX_OCTETS);
        t.sortieTronquee = true;
      } else t.sortie = m.sortie;
    }
    relayer({ bloc: m.id, etape: "fin", statut: m.statut, elements: t.elements });
  };

  const traiterLigne = (ligne: string) => {
    if (arret || terminal || !ligne.trim()) return;
    const m = lireMessageRecolteur(ligne);
    if (!m) return; // A line outside the protocol (the code wrote on stdout) is ignored.
    // A held memory not followed by a publication: it only keeps items already shown. Followed by
    // `fin`, it is only used for the `fin` outcome: the final output, not yet written, may still be refused.
    if (m.t === "fin") memoireTenue = null;
    else if (m.t !== "publication") libererMemoireTenue();
    if (m.t === "fin" || m.t === "echec") {
      terminal = m;
      processus.stdin.end();
      return;
    }
    if (m.t !== "appel") return traiterTrace(m);
    if (enVol >= MAX_APPELS_EN_VOL) return repondre(m.n, { erreur: "Trop d'appels en même temps" });
    enVol++;
    // Calls are handled as soon as they arrive, in parallel; each answer carries its call's number.
    traiterAppel(m.f, m.a)
      .then(
        (ok) => ok !== SANS_REPONSE && repondre(m.n, { ok: ok ?? null }),
        (e) => repondre(m.n, { erreur: tronquer(message(e), ERREUR_MAX) }),
      )
      .finally(() => enVol--);
  };

  // Line-by-line reading; a line of more than 4 MB stops the run before being accumulated in full.
  let tampon: Buffer[] = [];
  let taille = 0;
  processus.stdout.on("data", (d: Buffer) => {
    if (arret) return;
    let debutLigne = 0;
    for (let i = d.indexOf(10); i >= 0; i = d.indexOf(10, debutLigne)) {
      const morceau = d.subarray(debutLigne, i);
      if (taille + morceau.length > LIGNE_MAX_OCTETS) return arreter({ statut: "erreur", erreur: "Réponse trop grande" });
      const ligne = Buffer.concat([...tampon, morceau]).toString("utf8");
      tampon = [];
      taille = 0;
      debutLigne = i + 1;
      traiterLigne(ligne);
      if (arret) return;
    }
    const reste = d.subarray(debutLigne);
    if (!reste.length) return;
    taille += reste.length;
    if (taille > LIGNE_MAX_OCTETS) return arreter({ statut: "erreur", erreur: "Réponse trop grande" });
    tampon.push(Buffer.from(reste));
  });

  const code = await processus.fin;
  clearTimeout(minuteur);
  ctx.signal?.removeEventListener("abort", surSignal);
  finExecution.abort(new Error("Exécution finie"));
  // The final output is written after the last publication.
  await relais;
  // Progressive run: the last memory received comes back with a failure or a stop.
  const avecMemoire = <T extends IssueWorkflow>(issue: T): T => (progressif ? { ...issue, memoire: memoireSure } : issue);
  const fin = terminal as MessageRecolteur | null;
  const arretFinal = arret as Arret | null;
  if (arretFinal) {
    // Killing the docker client leaves the container running: we remove it.
    await infra.atelier.supprimerRecolte(ctx.proprietaire).catch(() => {});
    return conclure(avecMemoire({ t: "arret", ...arretFinal }));
  }
  if (fin?.t === "fin" && code === 0) {
    return conclure({ t: "fin", sortie: { vers: ctx.valide.sortie.vers, valeur: fin.donnees }, memoire: memoireRecue });
  }
  if (fin?.t === "echec") return conclure(avecMemoire(echec(fin.erreur, true)));
  if (code === 124) return conclure(avecMemoire(echec("Délai dépassé", false)));
  // The exit code is chosen by the agent's code: it could encode account data in it.
  return conclure(avecMemoire(echec(`La récolte s'est arrêtée sans résultat (code ${code ?? "aucun"})`, true)));
}

/** What is sent to the container: the entries of the same type and, if they have one, of the same hash. Without the hash. */
function reprendreMemoire(memoire: MemoireBlocs, types: Map<string, string>, empreintes: Map<string, string>): MemoireBlocs {
  const r: MemoireBlocs = {};
  for (const [id, e] of Object.entries(memoire)) {
    if (types.get(id) !== e?.type) continue;
    if (e.empreinte !== undefined && e.empreinte !== empreintes.get(id)) continue;
    r[id] = { type: e.type, valeur: e.valeur };
  }
  return r;
}

/** The memory returned by the container: this workflow's entries, marked with the hash of this run. */
function marquerMemoire(memoire: MemoireBlocs, types: Map<string, string>, empreintes: Map<string, string>): MemoireBlocs {
  const r: MemoireBlocs = {};
  for (const [id, e] of Object.entries(memoire)) {
    if (types.get(id) === e?.type) r[id] = { type: e.type, valeur: e.valeur, empreinte: empreintes.get(id)! };
  }
  return r;
}
