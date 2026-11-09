import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { HARVEST_DELAY_S, type Workshop } from "../container/workshop.js";
import { toolsPath } from "../container/runner.js";
import type { LocalAi } from "../ai/local-ai.js";
import { ProfileDenied, type BrowserBridge } from "../mcp/bridge.js";
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
} from "./protocol.js";
import { REPLAY_TOO_BIG } from "./replay.js";
import type { OutputKind, Owner } from "./schema.js";
import { WEB_REQUIRED, type ValidWorkflow } from "./validate.js";

/** The run's process (the `docker run -i` client): its only channel with the kernel is stdin / stdout. */
export interface HarvestProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  /** Exit code; null if killed by a signal or impossible to launch. */
  end: Promise<number | null>;
}
export type ProcessLauncher = (cmd: string, args: string[]) => HarvestProcess;

export const defaultLaunch: ProcessLauncher = (cmd, args) => {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: toolsPath() } });
  const end = new Promise<number | null>((ok) => {
    child.once("close", (code) => ok(code));
    child.once("error", () => ok(null));
  });
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, kill: () => void child.kill("SIGKILL"), end: end };
};

/** Kernel-side timeout; the container stops by itself after 180 s (+5 s). */
export const RUN_DELAY_MS = 200_000;

// Copied into the container's interpreter (docker/engine/interpreter.mjs): a test checks that they agree.
/** Gap between two as-it-goes publications. */
export const PUBLICATIONS_GAP_MS = 5000;
/** Gap between two sends of the memory along the way (progressive run). */
export const MEMORY_GAP_MS = 30_000;
/**
 * A publication that arrives less than 4 s after the previous relayed one is ignored: the container spaces them 5 s apart on
 * its clock, the margin covers the gap between the two clocks and the transport time.
 */
const TOLERATED_PUBLICATIONS_GAP_MS = PUBLICATIONS_GAP_MS - 1000;
/** Action: gap between two `progress` lines of the same block (the last one, `faits = total`, always goes). */
export const PROGRESS_GAP_MS = 1000;
/**
 * An `progress` line that arrives less than 500 ms after the previous relayed one of the same block is ignored (except the last):
 * the margin covers the gap between the clocks and the transport time, code that wrote them constantly is bounded.
 */
const TOLERATED_PROGRESS_GAP_MS = PROGRESS_GAP_MS / 2;
/** The host announced by the `read` trace of a web search. */
const SEARCH_HOST = "duckduckgo.com";

/**
 * The delays of a run. Without `maxDurationMinutes`: today's (container 180 s, kernel 200 s, no limit
 * sent: the interpreter keeps its 150 s). With D minutes: no item run after D × 60 s, container stopped
 * at D × 60 + 30 s, kernel at D × 60 + 50 s.
 */
export function runDelays(maxDurationMinutes: number | undefined): { containerS: number; kernelMs: number; limitMs?: number } {
  if (maxDurationMinutes === undefined) return { containerS: HARVEST_DELAY_S, kernelMs: RUN_DELAY_MS };
  return { containerS: maxDurationMinutes * 60 + 30, kernelMs: maxDurationMinutes * 60_000 + 50_000, limitMs: maxDurationMinutes * 60_000 };
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
  owner: Owner;
  valid: ValidWorkflow;
  /** Folder of the owner's files (`.mjs` of the `code` blocks), mounted read-only on `/widget`. */
  filesFolder: string;
  config: unknown;
  previous: unknown;
  memory: BlocksMemory;
  /**
   * Domains read with the user's account, and public domains allowed when there are some with an account. `web`: web searches
   * allowed and paced open reads (never with an account).
   */
  sources: { account: readonly string[]; public: readonly string[]; web?: boolean };
  /** Re-read at each read with an account; null = grant gone. */
  grant(): Promise<{ profile: string } | null>;
  /** The browser refuses the grant's profile (deleted, became private). */
  onProfileDenied(): Promise<void>;
  grantRequiredMessage: string;
  trigger: Execution["trigger"];
  /**
   * A builder try (plan of `replayPlan`): only the `reruns` blocks run, with the `outputs` taken
   * from the original run; no memory sent or kept. `resumed`: the taken blocks and their number of items.
   */
  replay?: { reruns: string[]; outputs: Record<string, unknown>; resumed: Record<string, number | null> };
  /** The widget's `harvest.maxDurationMinutes`: sets the delays and makes the run progressive (except a try). */
  maxDurationMinutes?: number;
  /** Action only: the text typed at launch, sent in `start` and copied into the run. */
  input?: string;
  /** Action only: the per-item blocks send their progress (relayed as an `progress` trace). */
  progress?: true;
  /** Action only: raised, the run is stopped (container killed) and concludes « interrompue » (ACTION_STOPPED). */
  signal?: AbortSignal;
}

/** An as-it-goes publication: the items already finished, `done` out of `total`. */
export type Publication = { data: unknown; done: number; total: number };

/**
 * An accepted trace (in order), relayed live to the builder. `progress`: coming from the container (action
 * only); `read`: emitted by the kernel at each accepted read, attached to the last block started and not finished.
 */
export type DirectTrace =
  | { block: string; step: "start" }
  | { block: string; step: "end"; status: "succeeded" | "partial" | "failed"; items: number | null }
  | { block: string; step: "progress"; done: number; total: number }
  | { block: string; step: "read"; host: string };

export interface InfraWorkflow {
  /** Folder of the engine on the Mac (`docker/engine`), mounted read-only. */
  engine: string;
  workshop: Pick<Workshop, "harvestCommand" | "deleteHarvest">;
  launch?: ProcessLauncher;
  /** null: no local AI, `kev` and `gemma` answer with an error. */
  ai: Pick<LocalAi, "kev" | "gemma"> | null;
  bridge: BrowserBridge;
  clock: () => Date;
  delayMs?: number;
  /** Tests only: allows `fetch` and `readPage` to local addresses (127.0.0.1…). */
  localAddresses?: boolean;
  /** Pacing of the searches and open reads (default: DEFAULT_PACING, shared). */
  pacing?: Pacing;
  /** Tests only: the base of the DuckDuckGo searches. */
  searchUrl?: string;
  /** Called for each accepted trace (never for a rejected line); an error from the relay is ignored. */
  onTrace?: (t: DirectTrace) => void;
  /**
   * An as-it-goes chain publication (see `runWorkflow`). The relays (publications and memory) are
   * done one after the other and all finished before the run returns; an error from a relay is ignored.
   */
  onPublish?: (p: Publication) => Promise<void>;
  /** Progressive run only: the memory received along the way, at most every MEMORY_GAP_MS. */
  onMemory?: (m: BlocksMemory) => Promise<void>;
}

export type WorkflowOutcome =
  | { t: "end"; output: { to: OutputKind; value: unknown }; memory: BlocksMemory | null }
  /**
   * `codeError`: the text comes from the container (the agent's code may have written it), not from the kernel. `memory` (progressive
   * run only, absent otherwise): the last memory received, null if none.
   */
  | { t: "failure"; error: string; codeError: boolean; memory?: BlocksMemory | null }
  /** Stopped by the kernel (delay, grant, profile refused, answer too big…): the text is the kernel's. `memory`: same. */
  | { t: "stop"; status: "erreur" | "accord-requis"; error: string; memory?: BlocksMemory | null };

function args<T>(schema: { safeParse(x: unknown): { success: true; data: T } | { success: false } }, a: unknown, f: string): T {
  const r = schema.safeParse(a);
  if (!r.success) throw new Error(`Arguments invalides pour ${f}`);
  return r.data;
}

/** The pacing shared by all the kernel's runs, when the caller gives none. */
export const DEFAULT_PACING = new Pacing();

type Stop = { status: "erreur" | "accord-requis"; error: string };
/** The run is stopped: the call receives no answer. */
const NO_RESPONSE = Symbol("sans réponse");

/** Trace of a block during the run, with what is needed to bound its log. */
type RunningTrace = BlockTrace & { started: boolean; done: boolean; cut: number };

/**
 * Runs a validated workflow in a container without network: sends `start` (workflow, config, previous) and the
 * blocks' memory, answers the calls (readPage, fetch, kev, gemma) with the rules of the sources and of the grant,
 * stores the blocks' traces. Writes nothing: the caller decides what is kept (privacy).
 *
 * Progressive run (not a try, with `maxDurationMinutes` or an as-it-goes output): the memory received along the
 * way is relayed (`onMemory`) and the last one comes back with a failure or a stop. A `publication` line is only
 * relayed (`onPublish`) during the as-it-goes chain (between the last `start` and the first `end` of
 * its blocks), at least 4 s after the previous relayed one, with `faits ≤ total` and data of 2 MB at most: a
 * publication written by the agent's code outside the chain, or late, cannot overwrite the final output.
 */
export async function runWorkflow(
  ctx: WorkflowContext,
  infra: InfraWorkflow,
): Promise<{ issue: WorkflowOutcome; run: Execution; log: string }> {
  const clock = infra.clock;
  const localUrls = infra.localAddresses ?? false;
  const start = clock().toISOString();
  const { workflow, order: order } = ctx.valid;
  const replay = ctx.replay ?? null;
  // For a try, only the rerun blocks send traces, in run order.
  const relaunches = replay ? new Set(replay.reruns) : null;
  const expected = relaunches ? order.filter((id) => relaunches.has(id)) : order;
  const types = new Map(workflow.blocks.map((b) => [b.id, b.type]));
  const streaming = workflow.blocks.find((b) => b.id === ctx.valid.output.id)?.params.live === true;
  const progressive = !replay && (ctx.maxDurationMinutes !== undefined || streaming);
  // A try has no chain: it runs block by block and publishes nothing.
  const chain = replay ? [] : streamingChain(ctx.valid);
  const delays = runDelays(ctx.maxDurationMinutes);
  // The validated params of this run: the memory is only taken back if it was kept with the same ones.
  const hashes = new Map(workflow.blocks.map((b) => [b.id, paramsHash(b.params)]));
  const traces = new Map<string, RunningTrace>(
    order.map((id) => [
      id,
      { id, type: types.get(id)!, status: "not-run", start: null, end: null, items: null, log: [], started: false, done: false, cut: 0 },
    ]),
  );
  if (replay) {
    for (const [id, items] of Object.entries(replay.resumed)) {
      const t = traces.get(id);
      if (t && !relaunches!.has(id)) Object.assign(t, { status: "resumed", items: items });
    }
  }
  let log = "";
  let remark: string | null = null;
  // Stopped by the caller's signal (an action's « Arrêter »): the run is « interrompue ».
  let stoppedBySignal = false;

  const conclude = (outcome: WorkflowOutcome) => {
    const blocks: BlockTrace[] = [...traces.values()].map(({ started: started, done: finished, cut: cuts, ...t }) => {
      const b: BlockTrace = { ...t };
      // Started without an end: the container stopped during the block (or was stopped on request).
      if (started && !finished) b.status = stoppedBySignal ? "interrupted" : "failed";
      if (cuts > 0) b.log = [`… ${cuts} lignes coupées`, ...t.log];
      return b;
    });
    const status: Execution["status"] =
      outcome.t === "end"
        ? // A partial block, or one that did not finish (a `fin` that arrived before it): the output is not complete. For a
          // try, only the rerun blocks count.
          blocks.every((b) => b.status === "succeeded" || (relaunches !== null && !relaunches.has(b.id))) ? "reussie" : "partielle"
        : outcome.t === "stop" && outcome.status === "accord-requis"
          ? "accord-requis"
          : outcome.t === "stop" && stoppedBySignal
            ? "interrompue"
            : "echouee";
    const run: Execution = {
      version: 1,
      id: idExecution(start),
      owner: ctx.owner,
      trigger: ctx.trigger,
      start: start,
      end: clock().toISOString(),
      status: status,
      blocks: blocks,
    };
    if (ctx.input !== undefined) run.input = ctx.input;
    if (outcome.t !== "end") {
      run.error = outcome.error;
      if (outcome.t === "stop" || !outcome.codeError) run.kernelError = true;
    }
    if (remark) {
      log = (log ? log + "\n" : "") + remark;
      // Also in the run, in the output block's log.
      blocks.find((b) => b.id === ctx.valid.output.id)?.log.push(remark);
    }
    return { issue: outcome, run, log: log.slice(-LOG_MAX) };
  };
  const failure = (error: string, codeError: boolean): WorkflowOutcome => ({ t: "failure", error: truncate(error, MAX_ERROR), codeError: codeError });

  // For an owner with an account, public reads are limited to the declared domains (empty: none).
  const hasAccount = ctx.sources.account.length > 0;
  const publicDomains = hasAccount ? ctx.sources.public : null;
  // Paced web searches and open reads: only for a widget that declares `web`, never with an account.
  const web = ctx.sources.web === true && !hasAccount;
  const pacing = infra.pacing ?? DEFAULT_PACING;
  // Raised at the stop or the end: a search or read still in the queue does not go out, and those in progress (bridge,
  // fetch) are abandoned. Specific to this run: the other runs' reads are not touched.
  const runEnd = new AbortController();
  let searches = 0;
  let searchDenied = false;
  let openReads = 0;

  const startLine = lineStart({
    previous: ctx.previous,
    now: start,
    config: ctx.config ?? null,
    workflow: { blocks: workflow.blocks, links: workflow.links, order: order },
    ...(replay ? { replay: { reruns: replay.reruns, outputs: replay.outputs } } : {}),
    ...(delays.limitMs !== undefined ? { limitMs: delays.limitMs } : {}),
    ...(progressive ? { progressive: true as const } : {}),
    ...(ctx.input !== undefined ? { input: ctx.input } : {}),
    ...(ctx.progress ? { progress: true as const } : {}),
  });
  // Safety net: the caller measures before (`startTooBig`) to refuse without writing anything; the harvester would refuse the line.
  if (replay && Buffer.byteLength(startLine) > LINE_MAX_BYTES) {
    return conclude({ t: "stop", status: "erreur", error: REPLAY_TOO_BIG });
  }

  // A container of the same name left by an abrupt stop would make `docker run` fail (125); the queues only launch
  // one per owner, so this one can only be a leftover. Before the signal test, perhaps raised meanwhile.
  await infra.workshop.deleteHarvest(ctx.owner).catch(() => {});
  // Stopped before even leaving: nothing is launched.
  if (ctx.signal?.aborted) {
    stoppedBySignal = true;
    return conclude({ t: "stop", status: "erreur", error: ACTION_STOPPED });
  }

  let process: HarvestProcess;
  try {
    const [cmd, ...argv] = infra.workshop.harvestCommand(ctx.owner, ctx.filesFolder, infra.engine, delays.containerS);
    process = (infra.launch ?? defaultLaunch)(cmd!, argv);
  } catch (e) {
    return conclude({ t: "stop", status: "erreur", error: `Récolte impossible à lancer : ${message(e)}` });
  }

  let stop: Stop | null = null;
  let terminal: Extract<HarvesterMessage, { t: "end" | "failure" }> | null = null;
  let receivedMemory: BlocksMemory | null = null;
  let inFlight = 0;
  // Relays to the caller (publications, memory), one after the other; all awaited before returning.
  let relais: Promise<void> = Promise.resolve();
  const queued = (f: () => Promise<void>) => {
    relais = relais.then(f).catch(() => {});
  };
  let memoryRelayedTo: number | null = null;
  // Progressive run: the container resolves the keys of the items a publication will show, sends `memory`,
  // then `publication`. If the kernel rejects this publication, these items were never shown: the memory must
  // stay the one from before (R34). A memory is therefore held until the next line:
  // - an accepted publication makes it safe; rejected, it is discarded, and so are the following memories (they
  //   still keep these keys) until the next accepted publication, which shows all the items again;
  // - another line (trace, call, echec, fin…) makes it safe: it did not precede a publication;
  // - nothing after (stop, container killed): discarded, it may have preceded a publication never read.
  // `safeMemory` is that of a failure or a stop and of the `onMemory` relays; an end keeps the last one received
  // (`receivedMemory`), because the output shows everything.
  let safeMemory: BlocksMemory | null = null;
  let heldMemory: { memory: BlocksMemory | null; receivedAt: number } | null = null;
  let doubtfulMemory = false;
  // The output block's `end` trace has passed: a memory received afterwards (checkMemory, just before `end`) has
  // resolved all the pending keys, which only the final output shows. It is only used for the `end` outcome
  // (`receivedMemory`), never relayed or safe: if the final data is refused, the previous safe memory stays.
  let outputDone = false;
  // Adoption happens in the relay queue, after the publications received before it: a memory is only safe
  // if the data it assumes shown has really been written (F1).
  const adoptInQueue = async (t: { memory: BlocksMemory | null; receivedAt: number }) => {
    if (!t.memory || doubtfulMemory) return;
    const memory = t.memory;
    safeMemory = memory;
    const onMemory = infra.onMemory;
    if (onMemory && (memoryRelayedTo === null || t.receivedAt - memoryRelayedTo >= MEMORY_GAP_MS)) {
      memoryRelayedTo = t.receivedAt;
      await onMemory(memory);
    }
  };
  const adoptMemory = (t: { memory: BlocksMemory | null; receivedAt: number }) => queued(() => adoptInQueue(t));
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
    process.kill();
  };
  const timer = setTimeout(() => stopRun({ status: "erreur", error: "Délai dépassé" }), infra.delayMs ?? delays.kernelMs);
  const onSignal = () => {
    if (stop) return;
    stoppedBySignal = true;
    stopRun({ status: "erreur", error: ACTION_STOPPED });
  };
  ctx.signal?.addEventListener("abort", onSignal, { once: true });

  process.stdin.on("error", () => {});
  process.stdin.write(startLine);
  // Only the memory of this workflow's blocks, with their type; none for a try.
  process.stdin.write(memoryLine(replay ? {} : resumeMemory(ctx.memory, types, hashes)));
  process.stderr.setEncoding("utf8");
  process.stderr.on("data", (d: string) => {
    log = (log + d).slice(-LOG_MAX);
  });

  const reply = (n: number, r: { ok: unknown } | { error: string }) => {
    if (stop || terminal || process.stdin.destroyed || process.stdin.writableEnded) return;
    let line = responseLine(n, r);
    if (Buffer.byteLength(line) > LINE_MAX_BYTES) line = responseLine(n, { error: "Réponse trop grande (4 Mo maximum)" });
    process.stdin.write(line);
  };

  /** Read options: for an owner with an account, the bridge receives the list of domains where it may navigate. */
  // Tests only: the bridge then also allows local addresses (it refuses them otherwise, redirects included).
  const withDomains = (profile: string | null, domains: readonly string[] | null) => ({
    profile: profile,
    ...(hasAccount && domains ? { domains: [...domains] } : {}),
    ...(localUrls ? { localAddresses: true } : {}),
    signal: runEnd.signal,
  });

  /**
   * An open read (page without account, fetch, feed): for a `web` widget, counted (100 per run) and
   * paced per host, redirects to another site included (`changeHost`); otherwise, done right away as before.
   */
  const openRead = <T>(u: URL, f: (changeHost?: ChangeHost) => Promise<T>): Promise<T> => {
    if (!web) return f();
    if (openReads >= MAX_OPEN_READS) throw new Error(TOO_MANY_READS);
    openReads++;
    return pacing.read(u.hostname, f, runEnd.signal);
  };

  const readPage = async (a: unknown): Promise<unknown> => {
    const { url, account: account, scroll: scroll } = args(ReadPageArgs, a, "readPage");
    const scrolling = scroll ? { scroll: scroll } : {};
    const read = infra.bridge.readPageInvisible?.bind(infra.bridge);
    if (!read) throw new Error("Lecture de pages indisponible");
    if (!account) {
      const u = checkUrl(url, publicDomains, localUrls);
      reportRead(u);
      const page = await openRead(u, (changeHost) => read(u.href, { ...withDomains(null, publicDomains), ...scrolling, ...(changeHost ? { changeHost: changeHost } : {}) }));
      return checkPage(page, publicDomains, localUrls);
    }
    // The domain must be declared in `account`; the grant is re-read at each read (it may have been withdrawn).
    const u = checkUrl(url, ctx.sources.account, localUrls);
    const grant = await ctx.grant();
    if (!grant) {
      stopRun({ status: "accord-requis", error: ctx.grantRequiredMessage });
      return NO_RESPONSE;
    }
    if (stop) return NO_RESPONSE;
    reportRead(u);
    try {
      const page = await read(u.href, { ...withDomains(grant.profile, ctx.sources.account), ...scrolling });
      return checkPage(page, ctx.sources.account, localUrls);
    } catch (e) {
      if (e instanceof ProfileDenied || (e as Error)?.name === "ProfileDenied") {
        // The caller withdraws the grant (and what was read with it) before the stop: when it concludes, it no longer exists.
        try {
          await ctx.onProfileDenied();
        } finally {
          stopRun({ status: "accord-requis", error: PROFILE_DENIED });
        }
        return NO_RESPONSE;
      }
      throw e;
    }
  };

  const searchWeb = async (a: unknown): Promise<unknown> => {
    const { query: request, count: count } = args(SearchWebArgs, a, "searchWeb");
    // Refused here even if the validation let it through: a `code` block or a harvest.mjs may call searchWeb.
    if (!web) throw new Error(WEB_REQUIRED);
    if (searchDenied) throw new Error(SEARCHES_STOPPED);
    if (searches >= MAX_SEARCHES) throw new Error(SEARCHES_CAP);
    const readHtml = infra.bridge.readHtmlInvisible?.bind(infra.bridge);
    if (!readHtml) throw new Error(SEARCH_UNAVAILABLE);
    searches++;
    reportRead(SEARCH_HOST);
    const r = await pacing.search(
      async () => {
        const { html } = await readHtml(searchUrl(request, infra.searchUrl ?? URL_DUCKDUCKGO), {
          ...(localUrls ? { localAddresses: true } : {}),
          signal: runEnd.signal,
        });
        const reads = extractResults(html, Infinity);
        // Marked before releasing the lane: a queued search sees the refusal before going out.
        if ("denial" in reads) searchDenied = true;
        return reads;
      },
      runEnd.signal,
      // A refusal that arrived during the wait: this one does not go out, and does not delay the next search.
      () => {
        if (searchDenied) throw new Error(SEARCHES_STOPPED);
      },
    );
    if ("denial" in r) throw new Error(SEARCH_DENIED);
    if ("unreadable" in r) throw new Error(UNREADABLE_RESULTS);
    // A result toward the machine or the local network is never returned (it would be read afterwards).
    return r.results.filter((x) => !localUrl(new URL(x.url).hostname)).slice(0, count);
  };

  const processCall = async (f: string, a: unknown): Promise<unknown> => {
    switch (f) {
      case "readPage":
        return readPage(a);
      case "fetch": {
        const { url, format } = args(FetchArgs, a, "fetch");
        const u = checkUrl(url, publicDomains, localUrls);
        reportRead(u);
        if (!web) return fetch(url, format ?? "text", publicDomains, localUrls, runEnd.signal);
        return openRead(u, (changeHost) => fetch(u.href, format ?? "text", publicDomains, localUrls, runEnd.signal, changeHost));
      }
      case "searchWeb":
        return searchWeb(a);
      case "kev": {
        const body = args(ArgsKev, a, "kev");
        if (!infra.ai) throw new Error("IA locale indisponible");
        // Stop or delay: the in-flight call is abandoned and gives its place back to the shared AI.
        return infra.ai.kev(body, { signal: runEnd.signal });
      }
      case "gemma": {
        const g = args(ArgsGemma, a, "gemma");
        if (!infra.ai) throw new Error("IA locale indisponible");
        return infra.ai.gemma({ ...g, signal: runEnd.signal });
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
  /** Between the last `start` and the first `end` of the chain: the only moment a publication counts. */
  const duringTheChain = () => chain.length > 0 && !closing && opened.length === chain.length && opened[0]!.id === chain[0];
  const relay = (t: DirectTrace) => {
    try {
      infra.onTrace?.(t);
    } catch {
      // The live relay never stops the run.
    }
  };
  /** An accepted read (URL host, or that of the web search), on the last block started and not finished. */
  function reportRead(target: URL | string) {
    const block = opened.at(-1);
    const host = typeof target === "string" ? target : target.hostname.toLowerCase().replace(/\.+$/, "");
    if (block) relay({ block: block.id, step: "read", host: host });
  }
  /** Per block: the time of the last relayed `progress` line. */
  const progressRelayedTo = new Map<string, number>();
  const processTrace = (m: Exclude<HarvesterMessage, { t: "call" | "end" | "failure" }>) => {
    if (m.t === "memory") {
      // A try keeps no memory: what the container says about it is ignored.
      if (replay) return;
      const filtered = markMemory(m.memory as BlocksMemory, types, hashes);
      const tooBig = Buffer.byteLength(JSON.stringify({ version: 1, blocks: filtered })) > MEMORY_MAX_BYTES;
      receivedMemory = tooBig ? null : filtered;
      remark = tooBig ? MEMORY_NOT_KEPT : null;
      if (progressive && !outputDone) heldMemory = { memory: tooBig ? null : filtered, receivedAt: clock().getTime() };
      return;
    }
    if (m.t === "publication") {
      const held = heldMemory;
      heldMemory = null;
      const now = clock().getTime();
      const onPublish = infra.onPublish;
      const accepted =
        duringTheChain() &&
        m.done <= m.total &&
        m.data !== undefined &&
        (publicationRelayedTo === null || now - publicationRelayedTo >= TOLERATED_PUBLICATIONS_GAP_MS) &&
        Buffer.byteLength(JSON.stringify(m.data)) <= DATA_MAX_SIZE &&
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
      const p: Publication = { data: m.data, done: m.done, total: m.total };
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
    if (m.t === "log") {
      const t = traces.get(m.block);
      if (!t || (relaunches && !relaunches.has(m.block))) return;
      t.log.push(truncate(m.text, LOG_BLOCK_CHARS));
      // The room for the « … N lignes coupées » line is kept: 200 lines at most in all.
      while (t.log.length + (t.cut > 0 ? 1 : 0) > BLOCK_LOG_LINES) {
        t.log.shift();
        t.cut++;
      }
      return;
    }
    const t = traces.get(m.id);
    if (!t) return;
    if (m.step === "progress") {
      // Only if the caller asked for it, for a block in progress, spaced out (the last one always).
      if (!ctx.progress || !opened.includes(t)) return;
      const now = clock().getTime();
      const before = progressRelayedTo.get(m.id);
      if (m.done < m.total && before !== undefined && now - before < TOLERATED_PROGRESS_GAP_MS) return;
      progressRelayedTo.set(m.id, now);
      relay({ block: m.id, step: "progress", done: m.done, total: m.total });
      return;
    }
    if (m.step === "start") {
      if (expected[next] !== m.id) return;
      // A block already open: only the chain's next block can start, before any end.
      if (opened.length > 0 && (closing || opened[0]!.id !== chain[0] || chain[opened.length] !== m.id)) return;
      next++;
      t.started = true;
      t.start = clock().toISOString();
      opened.push(t);
      relay({ block: m.id, step: "start" });
      return;
    }
    if (opened[0] !== t) return;
    opened.shift();
    closing = opened.length > 0;
    t.done = true;
    if (t.id === ctx.valid.output.id) outputDone = true;
    t.end = clock().toISOString();
    t.status = m.status;
    if (m.error !== undefined) t.error = truncate(m.error, MAX_ERROR);
    if (m.outputTooBig) t.outputTruncated = true;
    else if (m.output !== undefined) {
      t.items = Array.isArray(m.output) ? m.output.length : null;
      // The kernel never keeps more than 256 KB of a block's output: beyond, the start of its JSON, marked.
      const text = JSON.stringify(m.output);
      if (Buffer.byteLength(text) > OUTPUT_MAX_BYTES) {
        t.output = cut(text, OUTPUT_MAX_BYTES);
        t.outputTruncated = true;
      } else t.output = m.output;
    }
    relay({ block: m.id, step: "end", status: m.status, items: t.items });
  };

  const processLine = (line: string) => {
    if (stop || terminal || !line.trim()) return;
    const m = readHarvesterMessage(line);
    if (!m) return; // A line outside the protocol (the code wrote on stdout) is ignored.
    // A held memory not followed by a publication: it only keeps items already shown. Followed by
    // `end`, it is only used for the `end` outcome: the final output, not yet written, may still be refused.
    if (m.t === "end") heldMemory = null;
    else if (m.t !== "publication") releaseHeldMemory();
    if (m.t === "end" || m.t === "failure") {
      terminal = m;
      process.stdin.end();
      return;
    }
    if (m.t !== "call") return processTrace(m);
    if (inFlight >= MAX_CALLS_IN_FLIGHT) return reply(m.n, { error: "Trop d'appels en même temps" });
    inFlight++;
    // Calls are handled as soon as they arrive, in parallel; each answer carries its call's number.
    processCall(m.f, m.a)
      .then(
        (ok) => ok !== NO_RESPONSE && reply(m.n, { ok: ok ?? null }),
        (e) => reply(m.n, { error: truncate(message(e), MAX_ERROR) }),
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
      if (size + chunk.length > LINE_MAX_BYTES) return stopRun({ status: "erreur", error: "Réponse trop grande" });
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
    if (size > LINE_MAX_BYTES) return stopRun({ status: "erreur", error: "Réponse trop grande" });
    buffer.push(Buffer.from(rest));
  });

  const code = await process.end;
  clearTimeout(timer);
  ctx.signal?.removeEventListener("abort", onSignal);
  runEnd.abort(new Error("Exécution finie"));
  // The final output is written after the last publication.
  await relais;
  // Progressive run: the last memory received comes back with a failure or a stop.
  const withMemory = <T extends WorkflowOutcome>(outcome: T): T => (progressive ? { ...outcome, memory: safeMemory } : outcome);
  const end = terminal as HarvesterMessage | null;
  const finalStop = stop as Stop | null;
  if (finalStop) {
    // Killing the docker client leaves the container running: we remove it.
    await infra.workshop.deleteHarvest(ctx.owner).catch(() => {});
    return conclude(withMemory({ t: "stop", ...finalStop }));
  }
  if (end?.t === "end" && code === 0) {
    return conclude({ t: "end", output: { to: ctx.valid.output.to, value: end.data }, memory: receivedMemory });
  }
  if (end?.t === "failure") return conclude(withMemory(failure(end.error, true)));
  if (code === 124) return conclude(withMemory(failure("Délai dépassé", false)));
  // The exit code is chosen by the agent's code: it could encode account data in it.
  return conclude(withMemory(failure(`La récolte s'est arrêtée sans résultat (code ${code ?? "aucun"})`, true)));
}

/** What is sent to the container: the entries of the same type and, if they have one, of the same hash. Without the hash. */
function resumeMemory(memory: BlocksMemory, types: Map<string, string>, hashes: Map<string, string>): BlocksMemory {
  const r: BlocksMemory = {};
  for (const [id, e] of Object.entries(memory)) {
    if (types.get(id) !== e?.type) continue;
    if (e.hash !== undefined && e.hash !== hashes.get(id)) continue;
    r[id] = { type: e.type, value: e.value };
  }
  return r;
}

/** The memory returned by the container: this workflow's entries, marked with the hash of this run. */
function markMemory(memory: BlocksMemory, types: Map<string, string>, hashes: Map<string, string>): BlocksMemory {
  const r: BlocksMemory = {};
  for (const [id, e] of Object.entries(memory)) {
    if (types.get(id) === e?.type) r[id] = { type: e.type, value: e.value, hash: hashes.get(id)! };
  }
  return r;
}
