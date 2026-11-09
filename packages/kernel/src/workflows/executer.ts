import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { HARVEST_DELAY_S, type Workshop } from "../container/workshop.js";
import { toolsPath } from "../container/runner.js";
import type { LocalAi } from "../ai/ia-locale.js";
import { ProfileDenied, type BrowserBridge } from "../mcp/pont.js";
import {
  MAX_OPEN_READS,
  MAX_SEARCHES,
  SEARCHES_CAP,
  SEARCH_UNAVAILABLE,
  SEARCHES_STOPPED,
  TOO_MANY_READS,
  localUrl,
  message,
  fetch,
  truncate,
  checkPage,
  checkUrl,
} from "./access.js";
import { SEARCH_DENIED, UNREADABLE_RESULTS, URL_DUCKDUCKGO, extractResults, searchUrl } from "./duckduckgo.js";
import { streamingChain } from "./chain.js";
import { Pacing, type ChangeHost } from "./pacing.js";
import { ACTION_STOPPED, OUTPUT_MAX_BYTES, cut, idExecution, type Execution, type BlockTrace } from "./executions.js";
import { MEMORY_MAX_BYTES, paramsHash, type BlocksMemory } from "./memory.js";
import {
  SearchWebArgs,
  ArgsGemma,
  ArgsKev,
  ReadPageArgs,
  FetchArgs,
  LINE_MAX_BYTES,
  DATA_MAX_SIZE,
  lineStart,
  memoryLine,
  responseLine,
  readHarvesterMessage,
  type HarvesterMessage,
} from "./protocole.js";
import { REPLAY_TOO_BIG } from "./replay.js";
import type { OutputKind, Owner } from "./schema.js";
import { WEB_REQUIRED, type ValidWorkflow } from "./validate.js";

/** The run's process (the `docker run -i` client): its only channel with the kernel is stdin / stdout. */
export interface HarvestProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  tuer(): void;
  /** Exit code; null if killed by a signal or impossible to launch. */
  fin: Promise<number | null>;
}
export type ProcessLauncher = (cmd: string, args: string[]) => HarvestProcess;

export const defaultLaunch: ProcessLauncher = (cmd, args) => {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: toolsPath() } });
  const end = new Promise<number | null>((ok) => {
    child.once("close", (code) => ok(code));
    child.once("error", () => ok(null));
  });
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, tuer: () => void child.kill("SIGKILL"), fin: end };
};

/** Kernel-side timeout; the container stops by itself after 180 s (+5 s). */
export const RUN_DELAY_MS = 200_000;

// Copied into the container's interpreter (docker/moteur/interpreteur.mjs): a test checks that they agree.
/** Gap between two as-it-goes publications. */
export const PUBLICATIONS_GAP_MS = 5000;
/** Gap between two sends of the memory along the way (progressive run). */
export const MEMORY_GAP_MS = 30_000;
/**
 * A publication that arrives less than 4 s after the previous relayed one is ignored: the container spaces them 5 s apart on
 * its clock, the margin covers the gap between the two clocks and the transport time.
 */
const TOLERATED_PUBLICATIONS_GAP_MS = PUBLICATIONS_GAP_MS - 1000;
/** Action: gap between two `avancement` lines of the same block (the last one, `faits = total`, always goes). */
export const PROGRESS_GAP_MS = 1000;
/**
 * An `avancement` line that arrives less than 500 ms after the previous relayed one of the same block is ignored (except the last):
 * the margin covers the gap between the clocks and the transport time, code that wrote them constantly is bounded.
 */
const TOLERATED_PROGRESS_GAP_MS = PROGRESS_GAP_MS / 2;
/** The host announced by the `lecture` trace of a web search. */
const SEARCH_HOST = "duckduckgo.com";

/**
 * The delays of a run. Without `dureeMaxMinutes`: today's (container 180 s, kernel 200 s, no limit
 * sent: the interpreter keeps its 150 s). With D minutes: no item run after D × 60 s, container stopped
 * at D × 60 + 30 s, kernel at D × 60 + 50 s.
 */
export function runDelays(maxDurationMinutes: number | undefined): { conteneurS: number; noyauMs: number; limiteMs?: number } {
  if (maxDurationMinutes === undefined) return { conteneurS: HARVEST_DELAY_S, noyauMs: RUN_DELAY_MS };
  return { conteneurS: maxDurationMinutes * 60 + 30, noyauMs: maxDurationMinutes * 60_000 + 50_000, limiteMs: maxDurationMinutes * 60_000 };
}

export const PROFILE_DENIED =
  "Le profil de connexion choisi n'est plus utilisable (supprimé ou utilisé par un espace privé) : accord à redonner";

const MAX_CALLS_IN_FLIGHT = 32;
/**
 * Effective kernel caps: an error (run, block, call) at 500 characters, the global log at 2000.
 * Those of the container (2000 characters per trace) and of the runs' write (2 KB per line) are only safety nets.
 */
export const LOG_MAX = 2000;
export const MAX_ERROR = 500;
/** Kernel remark when the returned blocks' memory is too big for its file. */
export const MEMORY_NOT_KEPT = "Mémoire des blocs non gardée : plus de 3 Mo (l'ancienne reste)";
const BLOCK_LOG_LINES = 200;
const LOG_BLOCK_CHARS = 500;

export interface WorkflowContext {
  proprietaire: Owner;
  valide: ValidWorkflow;
  /** Folder of the owner's files (`.mjs` of the `code` blocks), mounted read-only on `/widget`. */
  dossierFichiers: string;
  config: unknown;
  precedent: unknown;
  memoire: BlocksMemory;
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
export type DirectTrace =
  | { bloc: string; etape: "debut" }
  | { bloc: string; etape: "fin"; statut: "reussi" | "partiel" | "echoue"; elements: number | null }
  | { bloc: string; etape: "avancement"; faits: number; total: number }
  | { bloc: string; etape: "lecture"; hote: string };

export interface InfraWorkflow {
  /** Folder of the engine on the Mac (`docker/moteur`), mounted read-only. */
  moteur: string;
  atelier: Pick<Workshop, "commandeRecolte" | "supprimerRecolte">;
  lancer?: ProcessLauncher;
  /** null: no local AI, `kev` and `gemma` answer with an error. */
  ia: Pick<LocalAi, "kev" | "gemma"> | null;
  pont: BrowserBridge;
  horloge: () => Date;
  delaiMs?: number;
  /** Tests only: allows `recuperer` and `lirePage` to local addresses (127.0.0.1…). */
  adressesLocales?: boolean;
  /** Pacing of the searches and open reads (default: MENAGEMENT_PAR_DEFAUT, shared). */
  menagement?: Pacing;
  /** Tests only: the base of the DuckDuckGo searches. */
  urlRecherche?: string;
  /** Called for each accepted trace (never for a rejected line); an error from the relay is ignored. */
  surTrace?: (t: DirectTrace) => void;
  /**
   * An as-it-goes chain publication (see `executerWorkflow`). The relays (publications and memory) are
   * done one after the other and all finished before the run returns; an error from a relay is ignored.
   */
  surPublication?: (p: Publication) => Promise<void>;
  /** Progressive run only: the memory received along the way, at most every ECART_MEMOIRE_MS. */
  surMemoire?: (m: BlocksMemory) => Promise<void>;
}

export type WorkflowOutcome =
  | { t: "fin"; sortie: { vers: OutputKind; valeur: unknown }; memoire: BlocksMemory | null }
  /**
   * `erreurDuCode`: the text comes from the container (the agent's code may have written it), not from the kernel. `memoire` (progressive
   * run only, absent otherwise): the last memory received, null if none.
   */
  | { t: "echec"; erreur: string; erreurDuCode: boolean; memoire?: BlocksMemory | null }
  /** Stopped by the kernel (delay, grant, profile refused, answer too big…): the text is the kernel's. `memoire`: same. */
  | { t: "arret"; statut: "erreur" | "accord-requis"; erreur: string; memoire?: BlocksMemory | null };

function args<T>(schema: { safeParse(x: unknown): { success: true; data: T } | { success: false } }, a: unknown, f: string): T {
  const r = schema.safeParse(a);
  if (!r.success) throw new Error(`Arguments invalides pour ${f}`);
  return r.data;
}

/** The pacing shared by all the kernel's runs, when the caller gives none. */
export const DEFAULT_PACING = new Pacing();

type Stop = { statut: "erreur" | "accord-requis"; erreur: string };
/** The run is stopped: the call receives no answer. */
const NO_RESPONSE = Symbol("sans réponse");

/** Trace of a block during the run, with what is needed to bound its log. */
type RunningTrace = BlockTrace & { commence: boolean; fini: boolean; coupees: number };

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
export async function runWorkflow(
  ctx: WorkflowContext,
  infra: InfraWorkflow,
): Promise<{ issue: WorkflowOutcome; execution: Execution; journal: string }> {
  const clock = infra.horloge;
  const localUrls = infra.adressesLocales ?? false;
  const start = clock().toISOString();
  const { workflow, ordre: order } = ctx.valide;
  const replay = ctx.rejeu ?? null;
  // For a try, only the rerun blocks send traces, in run order.
  const relaunches = replay ? new Set(replay.relances) : null;
  const expected = relaunches ? order.filter((id) => relaunches.has(id)) : order;
  const types = new Map(workflow.blocs.map((b) => [b.id, b.type]));
  const streaming = workflow.blocs.find((b) => b.id === ctx.valide.sortie.id)?.parametres.auFilDeLEau === true;
  const progressive = !replay && (ctx.dureeMaxMinutes !== undefined || streaming);
  // A try has no chain: it runs block by block and publishes nothing.
  const chain = replay ? [] : streamingChain(ctx.valide);
  const delays = runDelays(ctx.dureeMaxMinutes);
  // The validated params of this run: the memory is only taken back if it was kept with the same ones.
  const hashes = new Map(workflow.blocs.map((b) => [b.id, paramsHash(b.parametres)]));
  const traces = new Map<string, RunningTrace>(
    order.map((id) => [
      id,
      { id, type: types.get(id)!, statut: "pas-lance", debut: null, fin: null, elements: null, journal: [], commence: false, fini: false, coupees: 0 },
    ]),
  );
  if (replay) {
    for (const [id, elements] of Object.entries(replay.repris)) {
      const t = traces.get(id);
      if (t && !relaunches!.has(id)) Object.assign(t, { statut: "repris", elements });
    }
  }
  let log = "";
  let remark: string | null = null;
  // Stopped by the caller's signal (an action's « Arrêter »): the run is « interrompue ».
  let stoppedBySignal = false;

  const conclude = (outcome: WorkflowOutcome) => {
    const blocks: BlockTrace[] = [...traces.values()].map(({ commence: started, fini: finished, coupees: cuts, ...t }) => {
      const b: BlockTrace = { ...t };
      // Started without an end: the container stopped during the block (or was stopped on request).
      if (started && !finished) b.statut = stoppedBySignal ? "interrompu" : "echoue";
      if (cuts > 0) b.journal = [`… ${cuts} lignes coupées`, ...t.journal];
      return b;
    });
    const status: Execution["statut"] =
      outcome.t === "fin"
        ? // A partial block, or one that did not finish (a `fin` that arrived before it): the output is not complete. For a
          // try, only the rerun blocks count.
          blocks.every((b) => b.statut === "reussi" || (relaunches !== null && !relaunches.has(b.id))) ? "reussie" : "partielle"
        : outcome.t === "arret" && outcome.statut === "accord-requis"
          ? "accord-requis"
          : outcome.t === "arret" && stoppedBySignal
            ? "interrompue"
            : "echouee";
    const execution: Execution = {
      version: 1,
      id: idExecution(start),
      proprietaire: ctx.proprietaire,
      declencheur: ctx.declencheur,
      debut: start,
      fin: clock().toISOString(),
      statut: status,
      blocs: blocks,
    };
    if (ctx.saisie !== undefined) execution.saisie = ctx.saisie;
    if (outcome.t !== "fin") {
      execution.erreur = outcome.erreur;
      if (outcome.t === "arret" || !outcome.erreurDuCode) execution.erreurNoyau = true;
    }
    if (remark) {
      log = (log ? log + "\n" : "") + remark;
      // Also in the run, in the output block's log.
      blocks.find((b) => b.id === ctx.valide.sortie.id)?.journal.push(remark);
    }
    return { issue: outcome, execution, journal: log.slice(-LOG_MAX) };
  };
  const failure = (error: string, codeError: boolean): WorkflowOutcome => ({ t: "echec", erreur: truncate(error, MAX_ERROR), erreurDuCode: codeError });

  // For an owner with an account, public reads are limited to the declared domains (empty: none).
  const hasAccount = ctx.sources.compte.length > 0;
  const publicDomains = hasAccount ? ctx.sources.publiques : null;
  // Paced web searches and open reads: only for a widget that declares `web`, never with an account.
  const web = ctx.sources.web === true && !hasAccount;
  const pacing = infra.menagement ?? DEFAULT_PACING;
  // Raised at the stop or the end: a search or read still in the queue does not go out, and those in progress (bridge,
  // fetch) are abandoned. Specific to this run: the other runs' reads are not touched.
  const runEnd = new AbortController();
  let searches = 0;
  let searchDenied = false;
  let openReads = 0;

  const startLine = lineStart({
    precedent: ctx.precedent,
    maintenant: start,
    config: ctx.config ?? null,
    workflow: { blocs: workflow.blocs, liens: workflow.liens, ordre: order },
    ...(replay ? { rejeu: { relances: replay.relances, sorties: replay.sorties } } : {}),
    ...(delays.limiteMs !== undefined ? { limiteMs: delays.limiteMs } : {}),
    ...(progressive ? { progressif: true as const } : {}),
    ...(ctx.saisie !== undefined ? { saisie: ctx.saisie } : {}),
    ...(ctx.avancement ? { avancement: true as const } : {}),
  });
  // Safety net: the caller measures before (`debutTropGros`) to refuse without writing anything; the harvester would refuse the line.
  if (replay && Buffer.byteLength(startLine) > LINE_MAX_BYTES) {
    return conclude({ t: "arret", statut: "erreur", erreur: REPLAY_TOO_BIG });
  }

  // A container of the same name left by an abrupt stop would make `docker run` fail (125); the queues only launch
  // one per owner, so this one can only be a leftover. Before the signal test, perhaps raised meanwhile.
  await infra.atelier.supprimerRecolte(ctx.proprietaire).catch(() => {});
  // Stopped before even leaving: nothing is launched.
  if (ctx.signal?.aborted) {
    stoppedBySignal = true;
    return conclude({ t: "arret", statut: "erreur", erreur: ACTION_STOPPED });
  }

  let process: HarvestProcess;
  try {
    const [cmd, ...argv] = infra.atelier.commandeRecolte(ctx.proprietaire, ctx.dossierFichiers, infra.moteur, delays.conteneurS);
    process = (infra.lancer ?? defaultLaunch)(cmd!, argv);
  } catch (e) {
    return conclude({ t: "arret", statut: "erreur", erreur: `Récolte impossible à lancer : ${message(e)}` });
  }

  let stop: Stop | null = null;
  let terminal: Extract<HarvesterMessage, { t: "fin" | "echec" }> | null = null;
  let receivedMemory: BlocksMemory | null = null;
  let inFlight = 0;
  // Relays to the caller (publications, memory), one after the other; all awaited before returning.
  let relais: Promise<void> = Promise.resolve();
  const queued = (f: () => Promise<void>) => {
    relais = relais.then(f).catch(() => {});
  };
  let memoryRelayedTo: number | null = null;
  // Progressive run: the container resolves the keys of the items a publication will show, sends `memoire`,
  // then `publication`. If the kernel rejects this publication, these items were never shown: the memory must
  // stay the one from before (R34). A memory is therefore held until the next line:
  // - an accepted publication makes it safe; rejected, it is discarded, and so are the following memories (they
  //   still keep these keys) until the next accepted publication, which shows all the items again;
  // - another line (trace, call, echec, fin…) makes it safe: it did not precede a publication;
  // - nothing after (stop, container killed): discarded, it may have preceded a publication never read.
  // `memoireSure` is that of a failure or a stop and of the `surMemoire` relays; an end keeps the last one received
  // (`memoireRecue`), because the output shows everything.
  let safeMemory: BlocksMemory | null = null;
  let heldMemory: { memoire: BlocksMemory | null; recueA: number } | null = null;
  let doubtfulMemory = false;
  // The output block's `fin` trace has passed: a memory received afterwards (verifierMemoire, just before `fin`) has
  // resolved all the pending keys, which only the final output shows. It is only used for the `fin` outcome
  // (`memoireRecue`), never relayed or safe: if the final data is refused, the previous safe memory stays.
  let outputDone = false;
  // Adoption happens in the relay queue, after the publications received before it: a memory is only safe
  // if the data it assumes shown has really been written (F1).
  const adoptInQueue = async (t: { memoire: BlocksMemory | null; recueA: number }) => {
    if (!t.memoire || doubtfulMemory) return;
    const memory = t.memoire;
    safeMemory = memory;
    const onMemory = infra.surMemoire;
    if (onMemory && (memoryRelayedTo === null || t.recueA - memoryRelayedTo >= MEMORY_GAP_MS)) {
      memoryRelayedTo = t.recueA;
      await onMemory(memory);
    }
  };
  const adoptMemory = (t: { memoire: BlocksMemory | null; recueA: number }) => queued(() => adoptInQueue(t));
  const releaseHeldMemory = () => {
    const t = heldMemory;
    heldMemory = null;
    if (t) adoptMemory(t);
  };
  let publicationRelayedTo: number | null = null;
  const stopRun = (a: Stop) => {
    if (stop) return;
    stop = a;
    runEnd.abort(new Error("Exécution arrêtée"));
    process.tuer();
  };
  const timer = setTimeout(() => stopRun({ statut: "erreur", erreur: "Délai dépassé" }), infra.delaiMs ?? delays.noyauMs);
  const onSignal = () => {
    if (stop) return;
    stoppedBySignal = true;
    stopRun({ statut: "erreur", erreur: ACTION_STOPPED });
  };
  ctx.signal?.addEventListener("abort", onSignal, { once: true });

  process.stdin.on("error", () => {});
  process.stdin.write(startLine);
  // Only the memory of this workflow's blocks, with their type; none for a try.
  process.stdin.write(memoryLine(replay ? {} : resumeMemory(ctx.memoire, types, hashes)));
  process.stderr.setEncoding("utf8");
  process.stderr.on("data", (d: string) => {
    log = (log + d).slice(-LOG_MAX);
  });

  const reply = (n: number, r: { ok: unknown } | { erreur: string }) => {
    if (stop || terminal || process.stdin.destroyed || process.stdin.writableEnded) return;
    let line = responseLine(n, r);
    if (Buffer.byteLength(line) > LINE_MAX_BYTES) line = responseLine(n, { erreur: "Réponse trop grande (4 Mo maximum)" });
    process.stdin.write(line);
  };

  /** Read options: for an owner with an account, the bridge receives the list of domains where it may navigate. */
  // Tests only: the bridge then also allows local addresses (it refuses them otherwise, redirects included).
  const withDomains = (profile: string | null, domains: readonly string[] | null) => ({
    profil: profile,
    ...(hasAccount && domains ? { domaines: [...domains] } : {}),
    ...(localUrls ? { adressesLocales: true } : {}),
    signal: runEnd.signal,
  });

  /**
   * An open read (page without account, fetch, feed): for a `web` widget, counted (100 per run) and
   * paced per host, redirects to another site included (`changerHote`); otherwise, done right away as before.
   */
  const openRead = <T>(u: URL, f: (changeHost?: ChangeHost) => Promise<T>): Promise<T> => {
    if (!web) return f();
    if (openReads >= MAX_OPEN_READS) throw new Error(TOO_MANY_READS);
    openReads++;
    return pacing.lire(u.hostname, f, runEnd.signal);
  };

  const readPage = async (a: unknown): Promise<unknown> => {
    const { url, compte: account, defiler: scroll } = args(ReadPageArgs, a, "lirePage");
    const scrolling = scroll ? { defiler: scroll } : {};
    const read = infra.pont.lirePageInvisible?.bind(infra.pont);
    if (!read) throw new Error("Lecture de pages indisponible");
    if (!account) {
      const u = checkUrl(url, publicDomains, localUrls);
      reportRead(u);
      const page = await openRead(u, (changeHost) => read(u.href, { ...withDomains(null, publicDomains), ...scrolling, ...(changeHost ? { changerHote: changeHost } : {}) }));
      return checkPage(page, publicDomains, localUrls);
    }
    // The domain must be declared in `compte`; the grant is re-read at each read (it may have been withdrawn).
    const u = checkUrl(url, ctx.sources.compte, localUrls);
    const grant = await ctx.accord();
    if (!grant) {
      stopRun({ statut: "accord-requis", erreur: ctx.messageAccordRequis });
      return NO_RESPONSE;
    }
    if (stop) return NO_RESPONSE;
    reportRead(u);
    try {
      const page = await read(u.href, { ...withDomains(grant.profil, ctx.sources.compte), ...scrolling });
      return checkPage(page, ctx.sources.compte, localUrls);
    } catch (e) {
      if (e instanceof ProfileDenied || (e as Error)?.name === "ProfilRefuse") {
        // The caller withdraws the grant (and what was read with it) before the stop: when it concludes, it no longer exists.
        try {
          await ctx.surProfilRefuse();
        } finally {
          stopRun({ statut: "accord-requis", erreur: PROFILE_DENIED });
        }
        return NO_RESPONSE;
      }
      throw e;
    }
  };

  const searchWeb = async (a: unknown): Promise<unknown> => {
    const { requete: request, nombre: count } = args(SearchWebArgs, a, "chercherWeb");
    // Refused here even if the validation let it through: a `code` block or a recolte.mjs may call chercherWeb.
    if (!web) throw new Error(WEB_REQUIRED);
    if (searchDenied) throw new Error(SEARCHES_STOPPED);
    if (searches >= MAX_SEARCHES) throw new Error(SEARCHES_CAP);
    const readHtml = infra.pont.lireHtmlInvisible?.bind(infra.pont);
    if (!readHtml) throw new Error(SEARCH_UNAVAILABLE);
    searches++;
    reportRead(SEARCH_HOST);
    const r = await pacing.rechercher(
      async () => {
        const { html } = await readHtml(searchUrl(request, infra.urlRecherche ?? URL_DUCKDUCKGO), {
          ...(localUrls ? { adressesLocales: true } : {}),
          signal: runEnd.signal,
        });
        const reads = extractResults(html, Infinity);
        // Marked before releasing the lane: a queued search sees the refusal before going out.
        if ("refus" in reads) searchDenied = true;
        return reads;
      },
      runEnd.signal,
      // A refusal that arrived during the wait: this one does not go out, and does not delay the next search.
      () => {
        if (searchDenied) throw new Error(SEARCHES_STOPPED);
      },
    );
    if ("refus" in r) throw new Error(SEARCH_DENIED);
    if ("illisible" in r) throw new Error(UNREADABLE_RESULTS);
    // A result toward the machine or the local network is never returned (it would be read afterwards).
    return r.resultats.filter((x) => !localUrl(new URL(x.url).hostname)).slice(0, count);
  };

  const processCall = async (f: string, a: unknown): Promise<unknown> => {
    switch (f) {
      case "lirePage":
        return readPage(a);
      case "recuperer": {
        const { url, format } = args(FetchArgs, a, "recuperer");
        const u = checkUrl(url, publicDomains, localUrls);
        reportRead(u);
        if (!web) return fetch(url, format ?? "texte", publicDomains, localUrls, runEnd.signal);
        return openRead(u, (changeHost) => fetch(u.href, format ?? "texte", publicDomains, localUrls, runEnd.signal, changeHost));
      }
      case "chercherWeb":
        return searchWeb(a);
      case "kev": {
        const body = args(ArgsKev, a, "kev");
        if (!infra.ia) throw new Error("IA locale indisponible");
        // Stop or delay: the in-flight call is abandoned and gives its place back to the shared AI.
        return infra.ia.kev(body, { signal: runEnd.signal });
      }
      case "gemma": {
        const g = args(ArgsGemma, a, "gemma");
        if (!infra.ia) throw new Error("IA locale indisponible");
        return infra.ia.gemma({ ...g, signal: runEnd.signal });
      }
      default:
        throw new Error(`Fonction inconnue : ${f}`);
    }
  };

  // The traces come from the container, where the agent's code runs: it may write fake ones on stdout. Only
  // those of this workflow's blocks count, in run order (one block at a time), in the protocol's format.
  // For a try, only the rerun blocks: a line for a taken or non-rerun block is rejected. Only exception:
  // the as-it-goes chain, whose blocks all start in a row then finish in order.
  let next = 0;
  /** Blocks started and not yet finished, in order: a single one, or the chain's blocks. */
  const opened: RunningTrace[] = [];
  /** An end of the chain has arrived: no more starts accepted until its blocks have all finished. */
  let closing = false;
  /** Between the last `debut` and the first `fin` of the chain: the only moment a publication counts. */
  const duringTheChain = () => chain.length > 0 && !closing && opened.length === chain.length && opened[0]!.id === chain[0];
  const relay = (t: DirectTrace) => {
    try {
      infra.surTrace?.(t);
    } catch {
      // The live relay never stops the run.
    }
  };
  /** An accepted read (URL host, or that of the web search), on the last block started and not finished. */
  function reportRead(target: URL | string) {
    const block = opened.at(-1);
    const host = typeof target === "string" ? target : target.hostname.toLowerCase().replace(/\.+$/, "");
    if (block) relay({ bloc: block.id, etape: "lecture", hote: host });
  }
  /** Per block: the time of the last relayed `avancement` line. */
  const progressRelayedTo = new Map<string, number>();
  const processTrace = (m: Exclude<HarvesterMessage, { t: "appel" | "fin" | "echec" }>) => {
    if (m.t === "memoire") {
      // A try keeps no memory: what the container says about it is ignored.
      if (replay) return;
      const filtered = markMemory(m.memoire as BlocksMemory, types, hashes);
      const tooBig = Buffer.byteLength(JSON.stringify({ version: 1, blocs: filtered })) > MEMORY_MAX_BYTES;
      receivedMemory = tooBig ? null : filtered;
      remark = tooBig ? MEMORY_NOT_KEPT : null;
      if (progressive && !outputDone) heldMemory = { memoire: tooBig ? null : filtered, recueA: clock().getTime() };
      return;
    }
    if (m.t === "publication") {
      const held = heldMemory;
      heldMemory = null;
      const now = clock().getTime();
      const onPublish = infra.surPublication;
      const accepted =
        duringTheChain() &&
        m.faits <= m.total &&
        m.donnees !== undefined &&
        (publicationRelayedTo === null || now - publicationRelayedTo >= TOLERATED_PUBLICATIONS_GAP_MS) &&
        Buffer.byteLength(JSON.stringify(m.donnees)) <= DATA_MAX_SIZE &&
        onPublish !== undefined;
      if (!accepted) {
        // The container believes these items shown: its memory is no longer safe before the next accepted publication.
        if (progressive && (held || duringTheChain())) {
          queued(async () => {
            doubtfulMemory = true;
          });
        }
        return;
      }
      publicationRelayedTo = now;
      const p: Publication = { donnees: m.donnees, faits: m.faits, total: m.total };
      // The data first, then the memory they make safe; a refused write leaves it doubtful.
      queued(async () => {
        try {
          await onPublish!(p);
        } catch {
          doubtfulMemory = true;
          return;
        }
        doubtfulMemory = false;
        if (held) await adoptInQueue(held);
      });
      return;
    }
    if (m.t === "journal") {
      const t = traces.get(m.bloc);
      if (!t || (relaunches && !relaunches.has(m.bloc))) return;
      t.journal.push(truncate(m.texte, LOG_BLOCK_CHARS));
      // The room for the « … N lignes coupées » line is kept: 200 lines at most in all.
      while (t.journal.length + (t.coupees > 0 ? 1 : 0) > BLOCK_LOG_LINES) {
        t.journal.shift();
        t.coupees++;
      }
      return;
    }
    const t = traces.get(m.id);
    if (!t) return;
    if (m.etape === "avancement") {
      // Only if the caller asked for it, for a block in progress, spaced out (the last one always).
      if (!ctx.avancement || !opened.includes(t)) return;
      const now = clock().getTime();
      const before = progressRelayedTo.get(m.id);
      if (m.faits < m.total && before !== undefined && now - before < TOLERATED_PROGRESS_GAP_MS) return;
      progressRelayedTo.set(m.id, now);
      relay({ bloc: m.id, etape: "avancement", faits: m.faits, total: m.total });
      return;
    }
    if (m.etape === "debut") {
      if (expected[next] !== m.id) return;
      // A block already open: only the chain's next block can start, before any end.
      if (opened.length > 0 && (closing || opened[0]!.id !== chain[0] || chain[opened.length] !== m.id)) return;
      next++;
      t.commence = true;
      t.debut = clock().toISOString();
      opened.push(t);
      relay({ bloc: m.id, etape: "debut" });
      return;
    }
    if (opened[0] !== t) return;
    opened.shift();
    closing = opened.length > 0;
    t.fini = true;
    if (t.id === ctx.valide.sortie.id) outputDone = true;
    t.fin = clock().toISOString();
    t.statut = m.statut;
    if (m.erreur !== undefined) t.erreur = truncate(m.erreur, MAX_ERROR);
    if (m.sortieTropGrosse) t.sortieTronquee = true;
    else if (m.sortie !== undefined) {
      t.elements = Array.isArray(m.sortie) ? m.sortie.length : null;
      // The kernel never keeps more than 256 KB of a block's output: beyond, the start of its JSON, marked.
      const text = JSON.stringify(m.sortie);
      if (Buffer.byteLength(text) > OUTPUT_MAX_BYTES) {
        t.sortie = cut(text, OUTPUT_MAX_BYTES);
        t.sortieTronquee = true;
      } else t.sortie = m.sortie;
    }
    relay({ bloc: m.id, etape: "fin", statut: m.statut, elements: t.elements });
  };

  const processLine = (line: string) => {
    if (stop || terminal || !line.trim()) return;
    const m = readHarvesterMessage(line);
    if (!m) return; // A line outside the protocol (the code wrote on stdout) is ignored.
    // A held memory not followed by a publication: it only keeps items already shown. Followed by
    // `fin`, it is only used for the `fin` outcome: the final output, not yet written, may still be refused.
    if (m.t === "fin") heldMemory = null;
    else if (m.t !== "publication") releaseHeldMemory();
    if (m.t === "fin" || m.t === "echec") {
      terminal = m;
      process.stdin.end();
      return;
    }
    if (m.t !== "appel") return processTrace(m);
    if (inFlight >= MAX_CALLS_IN_FLIGHT) return reply(m.n, { erreur: "Trop d'appels en même temps" });
    inFlight++;
    // Calls are handled as soon as they arrive, in parallel; each answer carries its call's number.
    processCall(m.f, m.a)
      .then(
        (ok) => ok !== NO_RESPONSE && reply(m.n, { ok: ok ?? null }),
        (e) => reply(m.n, { erreur: truncate(message(e), MAX_ERROR) }),
      )
      .finally(() => inFlight--);
  };

  // Line-by-line reading; a line of more than 4 MB stops the run before being accumulated in full.
  let buffer: Buffer[] = [];
  let size = 0;
  process.stdout.on("data", (d: Buffer) => {
    if (stop) return;
    let startLine = 0;
    for (let i = d.indexOf(10); i >= 0; i = d.indexOf(10, startLine)) {
      const chunk = d.subarray(startLine, i);
      if (size + chunk.length > LINE_MAX_BYTES) return stopRun({ statut: "erreur", erreur: "Réponse trop grande" });
      const line = Buffer.concat([...buffer, chunk]).toString("utf8");
      buffer = [];
      size = 0;
      startLine = i + 1;
      processLine(line);
      if (stop) return;
    }
    const rest = d.subarray(startLine);
    if (!rest.length) return;
    size += rest.length;
    if (size > LINE_MAX_BYTES) return stopRun({ statut: "erreur", erreur: "Réponse trop grande" });
    buffer.push(Buffer.from(rest));
  });

  const code = await process.fin;
  clearTimeout(timer);
  ctx.signal?.removeEventListener("abort", onSignal);
  runEnd.abort(new Error("Exécution finie"));
  // The final output is written after the last publication.
  await relais;
  // Progressive run: the last memory received comes back with a failure or a stop.
  const withMemory = <T extends WorkflowOutcome>(outcome: T): T => (progressive ? { ...outcome, memoire: safeMemory } : outcome);
  const end = terminal as HarvesterMessage | null;
  const finalStop = stop as Stop | null;
  if (finalStop) {
    // Killing the docker client leaves the container running: we remove it.
    await infra.atelier.supprimerRecolte(ctx.proprietaire).catch(() => {});
    return conclude(withMemory({ t: "arret", ...finalStop }));
  }
  if (end?.t === "fin" && code === 0) {
    return conclude({ t: "fin", sortie: { vers: ctx.valide.sortie.vers, valeur: end.donnees }, memoire: receivedMemory });
  }
  if (end?.t === "echec") return conclude(withMemory(failure(end.erreur, true)));
  if (code === 124) return conclude(withMemory(failure("Délai dépassé", false)));
  // The exit code is chosen by the agent's code: it could encode account data in it.
  return conclude(withMemory(failure(`La récolte s'est arrêtée sans résultat (code ${code ?? "aucun"})`, true)));
}

/** What is sent to the container: the entries of the same type and, if they have one, of the same hash. Without the hash. */
function resumeMemory(memory: BlocksMemory, types: Map<string, string>, hashes: Map<string, string>): BlocksMemory {
  const r: BlocksMemory = {};
  for (const [id, e] of Object.entries(memory)) {
    if (types.get(id) !== e?.type) continue;
    if (e.empreinte !== undefined && e.empreinte !== hashes.get(id)) continue;
    r[id] = { type: e.type, valeur: e.valeur };
  }
  return r;
}

/** The memory returned by the container: this workflow's entries, marked with the hash of this run. */
function markMemory(memory: BlocksMemory, types: Map<string, string>, hashes: Map<string, string>): BlocksMemory {
  const r: BlocksMemory = {};
  for (const [id, e] of Object.entries(memory)) {
    if (types.get(id) === e?.type) r[id] = { type: e.type, valeur: e.valeur, empreinte: hashes.get(id)! };
  }
  return r;
}
