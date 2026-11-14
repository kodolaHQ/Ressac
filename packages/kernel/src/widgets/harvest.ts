import { say } from "../i18n.js";
import { inEveryLanguage, grantRequiredPatterns } from "../errors.js";
import { join } from "node:path";
import { writeData, writeWidgetState, readData, readWidgetState, changeWidgetState, deleteData } from "../home/data.js";
import type { DeclarationWidget, WidgetState, WidgetRead } from "../home/schemas.js";
import type { Workshop } from "../container/workshop.js";
import type { LocalAi } from "../ai/local-ai.js";
import type { BrowserBridge } from "../mcp/bridge.js";
import { grantValid, readGrants, removeGrant } from "./grants.js";
import { message, truncate } from "../workflows/access.js";
import {
  MAX_ERROR,
  LOG_MAX,
  MEMORY_NOT_KEPT,
  PROFILE_DENIED,
  runDelays,
  runWorkflow,
  type WorkflowContext,
  type WorkflowOutcome,
  type ProcessLauncher,
  type Publication,
  type DirectTrace,
} from "../workflows/run.js";
import { writeRun, attemptId, idExecution, readRun, listRuns, type Execution, type BlockTrace } from "../workflows/executions.js";
import { readWorkflow } from "../workflows/read.js";
import type { Pacing } from "../workflows/pacing.js";
import { withMemory, writeMemory, readMemory, type BlocksMemory } from "../workflows/memory.js";
import { countNew } from "./novelties.js";
import { startTooBig } from "../workflows/protocol.js";
import { REPLAY_DEPTH, REPLAY_TOO_BIG, replayPlan } from "../workflows/replay.js";
import { type Owner } from "../workflows/schema.js";
import type { ValidationContext, ValidWorkflow } from "../workflows/validate.js";

// Moved into the workflow engine; re-exported for the modules and tests that take them here.
export { localUrl } from "../workflows/access.js";
export { PROFILE_DENIED, defaultLaunch, type ProcessLauncher, type HarvestProcess } from "../workflows/run.js";

export interface HarvestOptions {
  /** The shown language, read when an error is written (default: English). */
  locale?: () => string;
  id: string;
  widget: WidgetRead;
  widgetsFolder: string;
  /** Folder of the workflow engine on the Mac (`docker/engine`), mounted read-only in the container. */
  engine: string;
  workshop: Pick<Workshop, "harvestCommand" | "deleteHarvest">;
  launch?: ProcessLauncher;
  /** null: no local AI, `kev` and `gemma` answer with an error. */
  ai: Pick<LocalAi, "kev" | "gemma"> | null;
  bridge: BrowserBridge;
  clock?: () => Date;
  /** Kernel-side timeout; the container stops by itself after 180 s (+5 s). */
  delayMs?: number;
  /** Called after each write of the widget's state or data (refresh the display). */
  onChange?: () => void;
  /** Tests only: allows `recuperer` and `lirePage` to local addresses (127.0.0.1…). */
  localAddresses?: boolean;
  /** What launched the run (default: the schedule). */
  trigger?: Execution["trigger"];
  /** True when the kernel is stopping: a run that did not finish is then « interrompue », not « échouée ». */
  interrupted?: () => boolean;
  /** Each accepted trace, live (the builder follows the blocks); must return control right away. */
  onTrace?: (t: DirectTrace) => void;
  /** Pacing of the searches and open reads, shared by all the kernel's runs. */
  pacing?: Pacing;
  /** Tests only: the base of the DuckDuckGo searches. */
  searchUrl?: string;
}

/**
 * Outcome of a builder try: `ok` as soon as it ran (even failing, its run says so); otherwise, the reason
 * for the refusal (nothing was written, no container launched or nothing kept from it).
 */
export type AttemptResult = { ok: true; run: string; status: Execution["status"] } | { ok: false; error: string };

/**
 * `execution`: the id of the written run (none when nothing ran, or when the grant was withdrawn meanwhile).
 * `nouveaux`: only for a finishing run of a `recolte.notifier` widget, the number of items that were
 * not in the data from before the run.
 */
export type HarvestResult = { state: WidgetState; data?: unknown; run?: string; newItems?: number };

const ID = /^[a-z0-9-]+$/;
const loc = (o: Pick<HarvestOptions, "locale">) => o.locale?.() ?? "en";

export const grantRequired = (d: Pick<DeclarationWidget, "sources">, locale: string) =>
  say(locale, "kernel-err-grant-required", { domains: d.sources.account.join(", ") });
export const WORKSHOP_STOPPED_ERROR = (locale: string) => say(locale, "kernel-err-workshop-stopped");
export const INTERNAL_HARVEST_ERROR = (locale: string) => say(locale, "kernel-err-internal-harvest");
export const NO_WORKFLOW_ERROR = (locale: string) => say(locale, "kernel-err-no-workflow");
export const INTERRUPTED_ERROR = (locale: string) => say(locale, "kernel-err-interrupted");

/**
 * Fixed error messages written by the kernel, in every shipped language (a stored error keeps the language it was
 * written in); any other error text may have been written by the widget.
 */
const FIXED_ERRORS = new Set([
  ...["kernel-err-timeout", "kernel-err-response-too-big", "kernel-err-profile-denied", "kernel-err-workshop-stopped", "kernel-err-internal-harvest", "kernel-err-no-workflow", "kernel-err-interrupted"].flatMap((id) => inEveryLanguage(id)),
  // Old message, still in states written before the workflows.
  "Ce widget n'a pas de harvest.mjs",
  ...inEveryLanguage("kernel-err-data-too-big"),
]);
const escapeChar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ERROR_PATTERNS = [
  ...grantRequiredPatterns(),
  // Written by the validation of workflow.json (drafted by the agent), never by the container. A widget can throw the same
  // text: it is then `erreurNoyau` (absent) that says so.
  ...inEveryLanguage("workflows-invalid-prefix").map((p) => new RegExp(`^${escapeChar(p)}`)),
];

/**
 * Does the error come from the kernel, without anything the widget could have written? For a widget that reads with the user's account,
 * only such an error (and marked `erreurNoyau` in the state) is shown to the agent without a grant.
 */
export function kernelError(error: string): boolean {
  return FIXED_ERRORS.has(error) || ERROR_PATTERNS.some((m) => m.test(error));
}

/** A widget's workflow: `workflow.json`, or `harvest.mjs` alone (implicit workflow). */
type WidgetWorkflow =
  | { t: "ok"; valid: ValidWorkflow; declaration: DeclarationWidget }
  /** The widget is unreadable: its error may quote its files. */
  | { t: "unreadable"; error: string }
  | { t: "absent" }
  /** workflow.json half-written, unknown block, cycle… (validator message, truncated). */
  | { t: "invalid"; error: string };

/** What the widget's declaration changes to the rules of its workflow. */
export function validationContext(d: DeclarationWidget, locale = "en"): ValidationContext {
  return { web: d.sources.web, maxDurationMinutes: d.harvest?.maxDurationMinutes ?? null, owner: "widget", input: false, locale: locale };
}

async function widgetWorkflow(widget: WidgetRead, locale: string): Promise<WidgetWorkflow> {
  if ("error" in widget) return { t: "unreadable", error: widget.error };
  const parsed = await readWorkflow(widget.folder, validationContext(widget.declaration, locale));
  if (!parsed) return { t: "absent" };
  if (!parsed.result.ok) return { t: "invalid", error: truncate(parsed.result.error, MAX_ERROR) };
  return { t: "ok", valid: parsed.result.valid, declaration: widget.declaration };
}

/**
 * A grant that no longer holds for the current declaration (domains changed, account removed) is withdrawn, and what was
 * read with it erased (data, runs, memory): nothing passes to the next harvest nor, later, to the agent.
 * `peut`: the widget may run (without account, or with a valid grant, which also covers its public domains);
 * `retire`: an expired grant has just been withdrawn.
 */
async function validGrant(widgetsFolder: string, id: string, declaration: DeclarationWidget): Promise<{ can: boolean; removed: boolean }> {
  const grantSaved = (await readGrants(widgetsFolder))[id];
  const removed = grantSaved !== undefined && !grantValid(declaration, grantSaved);
  if (removed) {
    await removeGrant(widgetsFolder, id);
    await deleteData(widgetsFolder, id);
  }
  const can = declaration.sources.account.length === 0 || grantValid(declaration, (await readGrants(widgetsFolder))[id]);
  return { can: can, removed: removed };
}

/**
 * The grant has just been lost outside a harvest (during a try): like `refuserAccord`, the widget goes into waiting
 * for a grant (dates kept) and the display is notified. Already waiting for a grant: nothing is rewritten.
 */
async function markGrantRequired(o: HarvestOptions, error: string): Promise<void> {
  const before = await readWidgetState(o.widgetsFolder, o.id);
  if (before.status === "grant-required") return;
  await writeWidgetState(o.widgetsFolder, o.id, {
    status: "grant-required",
    lastUpdate: before.lastUpdate,
    lastAttempt: before.lastAttempt,
    error: truncate(error, MAX_ERROR),
    kernelError: true,
  });
  o.onChange?.();
}

/** What a widget's run asks about its grant (re-read at each read with an account). */
function grantContext(
  widgetsFolder: string,
  id: string,
  declaration: DeclarationWidget,
  locale: string,
): Pick<WorkflowContext, "grant" | "onProfileDenied" | "grantRequiredMessage" | "sources"> {
  return {
    sources: declaration.sources,
    async grant() {
      const a = (await readGrants(widgetsFolder))[id];
      return grantValid(declaration, a) ? { profile: a.profile } : null;
    },
    // The grant is withdrawn before the stop: when the run concludes, it no longer exists. What was read with this account goes
    // with it (the widget shows its example until the new grant).
    async onProfileDenied() {
      await removeGrant(widgetsFolder, id);
      await deleteData(widgetsFolder, id);
    },
    grantRequiredMessage: grantRequired(declaration, locale),
  };
}

/** Has the grant been withdrawn (refuserAccord erases everything)? Always false for a widget without an account. */
async function removedGrantOf(widgetsFolder: string, id: string, declaration: DeclarationWidget): Promise<boolean> {
  return declaration.sources.account.length > 0 && !grantValid(declaration, (await readGrants(widgetsFolder))[id]);
}

/** What the infrastructure receives from the options of a harvest or a try. */
function infraOf(o: HarvestOptions, clock: () => Date): Parameters<typeof runWorkflow>[1] {
  return {
    engine: o.engine,
    workshop: o.workshop,
    ...(o.launch ? { launch: o.launch } : {}),
    ai: o.ai,
    bridge: o.bridge,
    clock: clock,
    ...(o.locale ? { locale: o.locale } : {}),
    ...(o.delayMs !== undefined ? { delayMs: o.delayMs } : {}),
    ...(o.localAddresses ? { localAddresses: true } : {}),
    ...(o.onTrace ? { onTrace: o.onTrace } : {}),
    ...(o.pacing ? { pacing: o.pacing } : {}),
    ...(o.searchUrl !== undefined ? { searchUrl: o.searchUrl } : {}),
  };
}

/** Kernel stop: the run did not fail, it is interrupted; a block started without an end is interrupted. */
export function markInterrupted(execution: Execution, locale: string): void {
  execution.status = "interrupted";
  execution.error = INTERRUPTED_ERROR(locale);
  execution.kernelError = true;
  execution.blocks = execution.blocks.map((b) => (b.start !== null && b.end === null ? { ...b, status: "interrupted" } : b));
}

/** Status and error from before a run (those from before the previous one, if it did not finish itself). */
function stateBeforeRun(e: WidgetState): NonNullable<WidgetState["before"]> {
  if (e.status === "running") return e.before ?? { status: "ok" };
  return { status: e.status, ...(e.error !== undefined ? { error: e.error } : {}), ...(e.kernelError ? { kernelError: true as const } : {}) };
}

/**
 * A widget's harvest: the run of its workflow (`workflow.json`, or `harvest.mjs` alone, as an implicit workflow)
 * by the engine, which writes nothing. Here, what is kept: `state.json` (running at the start), and depending on the outcome
 * `data.json`, `memory.json` and the run. For a widget with an account, the grant is re-read after each write:
 * withdrawn, everything read with it goes (data, runs, memory) and the widget waits for a new grant.
 */
export async function runHarvest(o: HarvestOptions): Promise<HarvestResult> {
  const { id, widget, widgetsFolder: widgetsFolder } = o;
  if (!ID.test(id) || widget.id !== id) throw new Error(`id de widget invalide : ${id}`);
  const clock = o.clock ?? (() => new Date());
  const dataFolder = join(widgetsFolder, id);
  const owner: Owner = { type: "widget", id };
  const trigger = o.trigger ?? "scheduled";
  const previous = await readWidgetState(widgetsFolder, id);
  const start = clock().toISOString();
  // The previous state, kept during the run: restored at the next startup if Ressac stops abruptly.
  const before = stateBeforeRun(previous);
  await writeWidgetState(widgetsFolder, id, { status: "running", lastUpdate: previous.lastUpdate, lastAttempt: start, before: before });
  o.onChange?.();

  /** `erreurWidget`: the error text comes from the widget or the container (otherwise, it is written by the kernel). */
  const conclude = async (r: {
    status: WidgetState["status"];
    error?: string;
    widgetError?: boolean;
    log?: string;
    data?: unknown;
    run?: string;
  }): Promise<HarvestResult> => {
    const state: WidgetState = {
      status: r.status,
      lastUpdate: r.status === "ok" ? clock().toISOString() : previous.lastUpdate,
      lastAttempt: start,
    };
    if (r.error) {
      state.error = truncate(r.error, MAX_ERROR);
      if (!r.widgetError) state.kernelError = true;
    }
    if (r.log) state.log = r.log;
    await writeWidgetState(widgetsFolder, id, state);
    o.onChange?.();
    return {
      state: state,
      ...(r.status === "ok" ? { data: r.data } : {}),
      ...(r.run ? { run: r.run } : {}),
    };
  };
  /** A run that the kernel stopped before any container: its blocks are not launched. */
  const withoutContainer = async (status: Execution["status"], error: string, blocks: BlockTrace[]): Promise<string> => {
    const e: Execution = {
      version: 1,
      id: idExecution(start),
      owner: owner,
      trigger: trigger,
      start: start,
      end: clock().toISOString(),
      status: status,
      error: error,
      kernelError: true,
      blocks: blocks,
    };
    await writeRun(dataFolder, e, loc(o));
    return e.id;
  };

  const parsed = await widgetWorkflow(widget, loc(o));
  // The widget's read error may quote its files: it counts as written by the widget.
  if (parsed.t === "unreadable") return conclude({ status: "error", error: parsed.error, widgetError: true });
  if (parsed.t === "absent") return conclude({ status: "error", error: NO_WORKFLOW_ERROR(loc(o)) });
  // workflow.json half-written, unknown block, cycle…: no container is launched, the data stays.
  if (parsed.t === "invalid") return conclude({ status: "error", error: parsed.error, run: await withoutContainer("failed", parsed.error, []) });
  const { valid: valid, declaration } = parsed;
  // A widget that reads with the user's account only runs with their grant (an expired grant is withdrawn, with its data).
  if (!(await validGrant(widgetsFolder, id, declaration)).can) {
    const error = grantRequired(declaration, loc(o));
    // Already waiting for a grant at the last run: not one more at each scheduling (they would push
    // the history of the real runs out), the last one stands in. Tries do not count.
    const last = (await listRuns(dataFolder)).find((e) => !e.attempt);
    if (last?.status === "grant-required") return conclude({ status: "grant-required", error: error, run: last.id });
    const notRun: BlockTrace[] = valid.order.map((b) => ({
      id: b,
      type: valid.workflow.blocks.find((x) => x.id === b)!.type,
      status: "not-run",
      start: null,
      end: null,
      items: null,
      log: [],
    }));
    return conclude({ status: "grant-required", error: error, run: await withoutContainer("grant-required", error, notRun) });
  }

  // The grant may have been withdrawn during the run (refuserAccord erases everything), or during a write from here (it may have
  // come after the erasure): nothing read with it remains, not even the run.
  const removedGrant = () => removedGrantOf(widgetsFolder, id, declaration);
  /** A run's memory, under the widget's memory lock, if the grant holds; false if too big. */
  const keepMemory = (m: BlocksMemory) =>
    withMemory(dataFolder, async () => (await removedGrant()) || (await writeMemory(dataFolder, m)));

  // Progressive run (the engine relays nothing to the others): each accepted publication is written right away,
  // with the progress in the state; the safe memory received along the way too. The engine does these relays one
  // after the other and waits for all of them before returning: the final output, written afterwards, is never overwritten.
  // Grant withdrawn (widget with an account): what was published goes, and nothing more is written along the way.
  const dataBefore = await readData(widgetsFolder, id);
  let closedRelays = false;
  const closeIfGrantRemoved = async (): Promise<boolean> => {
    if (!(await removedGrant())) return false;
    closedRelays = true;
    await deleteData(widgetsFolder, id);
    return true;
  };
  const onPublish = async (p: Publication) => {
    if (closedRelays) return;
    await writeData(widgetsFolder, id, p.data, loc(o));
    if (await closeIfGrantRemoved()) return;
    const progress = { done: p.done, total: p.total };
    // Only on top of this run's en-cours: an accord-requis written in the meantime (refuserAccord) stays.
    await changeWidgetState(widgetsFolder, id, (e) =>
      e.status === "running" ? { status: "running", lastUpdate: previous.lastUpdate, lastAttempt: start, progress, before: before } : null,
    );
    if (await closeIfGrantRemoved()) return;
    o.onChange?.();
  };
  const onMemory = async (m: BlocksMemory) => {
    if (closedRelays) return;
    await keepMemory(m);
  };

  const maxDurationMinutes = declaration.harvest?.maxDurationMinutes;
  const { issue: outcome, run: execution, log: runLog } = await runWorkflow(
    {
      owner: owner,
      valid: valid,
      filesFolder: widget.folder,
      config: declaration.config ?? null,
      previous: dataBefore,
      memory: await readMemory(dataFolder),
      ...grantContext(widgetsFolder, id, declaration, loc(o)),
      trigger: trigger,
      ...(maxDurationMinutes !== undefined ? { maxDurationMinutes: maxDurationMinutes } : {}),
    },
    { ...infraOf(o, clock), onPublish: onPublish, onMemory: onMemory },
  );
  // The relays are all finished (the engine waits for them): nothing more is written along the way.
  closedRelays = true;
  let log = runLog;

  const denied = async () => {
    await deleteData(widgetsFolder, id);
    return conclude({ status: "grant-required", error: denialMessage(outcome, declaration, loc(o)) });
  };
  /**
   * Failure or stop: the run is written; the data (previous, or published along the way) stays. The
   * previous memory stays, except for a progressive run that returns its last safe memory (`memoire`).
   */
  const concludeWithoutData = async (e: Execution, r: Parameters<typeof conclude>[0], memory?: BlocksMemory | null): Promise<HarvestResult> => {
    await writeRun(dataFolder, e, loc(o));
    if (await removedGrant()) return denied();
    if (memory) {
      await keepMemory(memory);
      if (await removedGrant()) return denied();
    }
    const finished = await conclude({ ...r, run: e.id });
    if (await removedGrant()) return denied();
    return finished;
  };
  if (await removedGrant()) return denied();

  if (outcome.t === "end") {
    try {
      if (outcome.output.to === "widget") await writeData(widgetsFolder, id, outcome.output.value, loc(o));
    } catch (e) {
      // Data refused (too big…): the previous ones stay, the run fails kernel-side.
      execution.status = "failed";
      execution.error = truncate(message(e), MAX_ERROR);
      execution.kernelError = true;
      return concludeWithoutData(execution, { status: "error", error: execution.error, log: log });
    }
    if (await removedGrant()) return denied();
    if (outcome.memory) {
      if (!(await keepMemory(outcome.memory))) {
        log = add(log, MEMORY_NOT_KEPT(loc(o)));
        // Also in the run, in the output block's log.
        execution.blocks.find((b) => b.id === valid.output.id)?.log.push(MEMORY_NOT_KEPT(loc(o)));
      }
      if (await removedGrant()) return denied();
    }
    await writeRun(dataFolder, execution, loc(o));
    if (await removedGrant()) return denied();
    const ok = await conclude({ status: "ok", data: outcome.output.value, log: log, run: execution.id });
    // Withdrawn during the state write: « ok » must not overwrite the accord-requis written by refuserAccord.
    if (await removedGrant()) return denied();
    // Counted against the data from before the run (those published along the way are not in it).
    if (declaration.harvest?.notify === true) return { ...ok, newItems: countNew(dataBefore, outcome.output.value) };
    return ok;
  }

  // Kernel stop (exit, profile change): the run did not fail, it is interrupted.
  // Its error is the kernel's (not the irrelevant one of the killed container); a block started without an end is interrupted.
  const interrupted = o.interrupted?.() === true && execution.status !== "grant-required";
  if (interrupted) markInterrupted(execution, loc(o));
  // Progressive run: its last safe memory is kept (never when it stops for lack of a grant).
  const memory = outcome.t === "stop" && outcome.status === "grant-required" ? null : outcome.memory;
  return outcome.t === "stop"
    ? concludeWithoutData(execution, { status: outcome.status, error: outcome.error, log: log }, memory)
    : // The provenance comes from the engine: `erreurNoyau` absent, the text may have been written by the widget's code.
      // Interrupted: the message is the kernel's, not the text the widget's code may have written.
      concludeWithoutData(
        execution,
        interrupted
          ? { status: "error", error: INTERRUPTED_ERROR(loc(o)), log: log }
          : { status: "error", error: outcome.error, widgetError: !execution.kernelError, log: log },
        memory,
      );
}

/**
 * A builder try: replays the widget's workflow from block `depart`, taking from run
 * `origine` the output of the upstream blocks. What the try produces never touches `state.json`, `data.json` nor
 * `memory.json`: only the `-attempt` run is kept (a failed try shows no error on the home). Like
 * a harvest, a widget with an account only runs with the user's grant. Only exception: a grant lost because of
 * the try (expired at the start, profile refused, withdrawn meanwhile) follows the normal withdrawal path — everything read with it
 * goes, try included, and the widget goes to `accord-requis`.
 */
export async function runAttempt(o: HarvestOptions & { origin: string; start: string }): Promise<AttemptResult> {
  const { id, widget, widgetsFolder: widgetsFolder } = o;
  if (!ID.test(id) || widget.id !== id) throw new Error(`id de widget invalide : ${id}`);
  const clock = o.clock ?? (() => new Date());
  const dataFolder = join(widgetsFolder, id);
  const denial = (error: string): AttemptResult => ({ ok: false, error: error });

  const parsed = await widgetWorkflow(widget, loc(o));
  if (parsed.t === "absent") return denial(NO_WORKFLOW_ERROR(loc(o)));
  if (parsed.t !== "ok") return denial(parsed.error);
  const { valid: valid, declaration } = parsed;
  const grant = await validGrant(widgetsFolder, id, declaration);
  if (!grant.can) {
    // Expired grant withdrawn: the widget waits for a new grant. Never given: nothing is written.
    if (grant.removed) await markGrantRequired(o, grantRequired(declaration, loc(o)));
    return denial(grantRequired(declaration, loc(o)));
  }

  const [origin, earlier] = await originChain(dataFolder, o.origin);
  const plan = replayPlan(valid, origin, o.start, earlier);
  if (!plan.ok) return denial(plan.error);
  const previous = await readData(widgetsFolder, id);
  const config = declaration.config ?? null;
  const workflow = { blocks: valid.workflow.blocks, links: valid.workflow.links, order: valid.order };
  const replay = { reruns: plan.reruns, outputs: plan.outputs };
  // A try has the delays of the widget's maximum duration (a watch must be tryable), without ever being progressive.
  const maxDurationMinutes = declaration.harvest?.maxDurationMinutes;
  const { limitMs: limitMs } = runDelays(maxDurationMinutes);
  // Measured before any container, on the line as it will go out: the harvester would refuse it, and nothing must be written.
  const now = clock().toISOString();
  if (startTooBig({ previous: previous, now: now, config, workflow, replay: replay, ...(limitMs !== undefined ? { limitMs: limitMs } : {}) })) {
    return denial(REPLAY_TOO_BIG);
  }

  const { issue: outcome, run: execution } = await runWorkflow(
    {
      owner: { type: "widget", id },
      valid: valid,
      filesFolder: widget.folder,
      config,
      previous: previous,
      // A try neither receives nor keeps any memory.
      memory: {},
      ...grantContext(widgetsFolder, id, declaration, loc(o)),
      trigger: "replay",
      replay: { ...replay, resumed: plan.resumed },
      ...(maxDurationMinutes !== undefined ? { maxDurationMinutes: maxDurationMinutes } : {}),
    },
    infraOf(o, clock),
  );
  // The executor's safety net (the measure here must have refused before): a refusal, nothing written.
  if (outcome.t === "stop" && outcome.error === REPLAY_TOO_BIG) return denial(REPLAY_TOO_BIG);

  // The grant may have been withdrawn during the try, or during its write: nothing read with it remains.
  const removed = async () => {
    if (!(await removedGrantOf(widgetsFolder, id, declaration))) return null;
    await deleteData(widgetsFolder, id);
    const error = denialMessage(outcome, declaration, loc(o));
    await markGrantRequired(o, error);
    return denial(error);
  };
  const before = await removed();
  if (before) return before;

  execution.id = attemptId(execution.start);
  execution.attempt = { start: o.start, origin: plan.origin };
  if (outcome.t !== "end" && o.interrupted?.() === true && execution.status !== "grant-required") markInterrupted(execution, loc(o));
  await writeRun(dataFolder, execution, loc(o));
  const after = await removed();
  if (after) return after;
  return { ok: true, run: execution.id, status: execution.status };
}

/**
 * The original run of a try and, when it is itself a try, the chain of its origins (bounded): their
 * `repris` blocks find their output there. A pruned origin stops the chain.
 */
export async function originChain(dataFolder: string, id: string): Promise<[Execution | null, Execution[]]> {
  const origin = await readRun(dataFolder, id);
  const earlier: Execution[] = [];
  const seen = new Set([id]);
  let e = origin;
  while (e?.attempt && earlier.length < REPLAY_DEPTH - 1 && !seen.has(e.attempt.origin)) {
    seen.add(e.attempt.origin);
    e = await readRun(dataFolder, e.attempt.origin);
    if (e) earlier.push(e);
  }
  return [origin, earlier];
}

/** The message of a widget waiting for a new grant: the engine's if it stopped for that (profile refused…). */
function denialMessage(outcome: WorkflowOutcome, declaration: DeclarationWidget, locale: string): string {
  return outcome.t === "stop" && outcome.status === "grant-required" ? outcome.error : grantRequired(declaration, locale);
}

function add(log: string, line: string): string {
  return ((log ? log + "\n" : "") + line).slice(-LOG_MAX);
}
