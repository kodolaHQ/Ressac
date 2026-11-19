import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SpacePaths } from "../paths.js";
import type { Workshop } from "../container/workshop.js";
import type { AiAccessRun } from "../ai/dispatcher.js";
import type { BrowserBridge } from "../mcp/bridge.js";
import { BUILTIN_COMPONENTS } from "../pages/catalog.js";
import { readAgentComponents } from "../pages/agent-components.js";
import { layOut } from "../pages/layout-page.js";
import { grantValid, readGrants, removeGrant } from "../widgets/grants.js";
import { codeCheck, readReads, readsApproved, readsUnrestricted } from "../widgets/reads.js";
import { originChain, markInterrupted, grantRequired } from "../widgets/harvest.js";
import { message, truncate } from "../workflows/access.js";
import {
  MAX_ERROR,
  MEMORY_NOT_KEPT,
  runDelays,
  runWorkflow,
  type WorkflowContext,
  type WorkflowOutcome,
  type ProcessLauncher,
  type DirectTrace,
} from "../workflows/run.js";
import { ID_EXECUTION, writeRun, attemptId, type Execution } from "../workflows/executions.js";
import type { Pacing } from "../workflows/pacing.js";
import { withMemory, writeMemory, readMemory } from "../workflows/memory.js";
import { startTooBig } from "../workflows/protocol.js";
import { REPLAY_TOO_BIG, replayPlan } from "../workflows/replay.js";
import { say } from "../i18n.js";
import type { Owner } from "../workflows/schema.js";
import { writeResult, deleteDataAction } from "./data.js";
import { readAction, actionWorkflow } from "./read.js";
import type { DeclarationAction } from "./schemas.js";

export const ACTION_UNKNOWN = (locale: string) => say(locale, "kernel-err-action-unknown");
export const requiredInput = (locale: string, label: string) => say(locale, "kernel-err-input-required", { label });
/** Same text as for a widget. */
export const actionGrantRequired = (d: DeclarationAction, locale: string) => grantRequired(d, locale);
export const ACTION_WITHOUT_WORKFLOW = (locale: string) => say(locale, "kernel-err-action-no-workflow");
export const RESULT_TOO_BIG = (locale: string) => say(locale, "kernel-err-result-too-big");
/** Maximum length of the kept input (that of `Execution.saisie`). */
export const INPUT_MAX = 200;

/** The outcome of a launch: `invalide` when nothing ran (unknown action, invalid workflow, missing input…). */
export type LaunchResult = { status: Execution["status"] | "invalid"; run?: string; error?: string; kernelError?: true };

/** A trace of an action's workflow, with its block type (the page shows its label from the catalog). */
export type TraceAction = DirectTrace & { type?: string };

export interface OptionsAction {
  /** The shown language, read when an error is written (default: English). */
  locale?: () => string;
  id: string;
  paths: SpacePaths;
  /** Runs, results, memory and grants of actions, outside the workspace (`<profile>/actions`). */
  actionsFolder: string;
  engine: string;
  workshop: Pick<Workshop, "stageHarvest" | "harvestCommand" | "deleteHarvest">;
  launch?: ProcessLauncher;
  bridge: BrowserBridge;
  /** This run's access to the local AI (priority), for blocks and layout; null without AI. */
  ai: AiAccessRun | null;
  clock?: () => Date;
  input: string | null;
  trigger: Execution["trigger"];
  /** « Stop »: raised during the workflow, the run is interrupted; during the layout, the fallback one. */
  signal: AbortSignal;
  onTrace(t: TraceAction): void;
  onStep(e: "layout"): void;
  /** A builder trial: replays from `depart` with the upstream outputs of run `origine`. */
  attempt?: { origin: string; start: string };
  /** True when the kernel stops: the run is then « interrupted » by Ressac, not by the user. */
  interrupted?: () => boolean;
  localAddresses?: boolean;
  pacing?: Pacing;
  searchUrl?: string;
  layoutDelayMs?: number;
}

/** The input as it is kept and sent: trimmed, at most `SAISIE_MAX` characters; null if empty. */
export function cutInput(input: string | null | undefined): string | null {
  let s = (input ?? "").trim().slice(0, INPUT_MAX);
  // No half character at the end.
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  s = s.trimEnd();
  return s === "" ? null : s;
}

const denial = (error: string, kernel = true): LaunchResult => ({ status: "invalid", error: error, ...(kernel ? { kernelError: true as const } : {}) });

/** Like the widgets' `validGrant`: a stale grant is withdrawn, and what was read with it erased. Without account: the approved reads. */
async function validGrant(actionsFolder: string, id: string, d: DeclarationAction): Promise<boolean> {
  const saved = (await readGrants(actionsFolder))[id];
  if (saved !== undefined && !grantValid(d, saved)) {
    // Data first: until it is gone, the grant still guards it (a crash in between leaves it guarded).
    await deleteDataAction(actionsFolder, id);
    await removeGrant(actionsFolder, id);
  }
  if (d.sources.account.length === 0) return readsApproved(d, (await readReads(actionsFolder))[id]);
  return grantValid(d, (await readGrants(actionsFolder))[id]);
}

/**
 * Launches an action: its workflow in the container, then the layout of its result by the writer (a fallback without
 * it). Kept, in order: the run, the result, the memory (never for a trial). Nothing is written when
 * the action could not run. For an action with an account, the grant is re-read after each write: withdrawn, everything
 * read with it goes. An action whose folder disappeared meanwhile keeps nothing.
 */
export async function runAction(o: OptionsAction): Promise<LaunchResult> {
  const { id, paths, actionsFolder } = o;
  const clock = o.clock ?? (() => new Date());
  const loc = () => o.locale?.() ?? "en";
  const action = await readAction(paths, id);
  if (!action) return denial(ACTION_UNKNOWN(loc()));
  // The read error of action.json quotes its content (key names): it is not a fixed kernel text.
  if ("error" in action) return denial(action.error, false);
  const wf = await actionWorkflow(action, loc());
  if (wf.t === "absent") return denial(ACTION_WITHOUT_WORKFLOW(loc()));
  if (wf.t !== "ok") return denial(truncate(wf.error, MAX_ERROR), wf.t !== "unreadable");
  const { valid } = wf;
  const { declaration } = action;
  const dataFolder = join(actionsFolder, id);
  const owner: Owner = { type: "action", id };
  const blockTypes = new Map(valid.workflow.blocks.map((b) => [b.id, b.type]));

  // A trial resumes the upstream outputs of a run: its input too, in the absence of a new one.
  const replay = o.attempt ? await originChain(dataFolder, o.attempt.origin) : null;
  const input = declaration.input ? cutInput(o.input ?? replay?.[0]?.input ?? null) : null;
  if (declaration.input && input === null) return denial(requiredInput(loc(), declaration.input.label));

  if (!(await validGrant(actionsFolder, id, declaration))) {
    return { status: "grant-required", error: actionGrantRequired(declaration, loc()), kernelError: true };
  }

  let plan: Extract<ReturnType<typeof replayPlan>, { ok: true }> | null = null;
  if (o.attempt && replay) {
    const p = replayPlan(valid, replay[0], o.attempt.start, replay[1], loc());
    if (!p.ok) return denial(p.error);
    const { limitMs } = runDelays(declaration.maxDurationMinutes);
    const workflow = { blocks: valid.workflow.blocks, links: valid.workflow.links, order: valid.order };
    const start = {
      previous: null,
      now: clock().toISOString(),
      config: null,
      workflow,
      replay: { reruns: p.reruns, outputs: p.outputs },
      ...(limitMs !== undefined ? { limitMs: limitMs } : {}),
      ...(input !== null ? { input: input } : {}),
      progress: true as const,
    };
    if (startTooBig(start)) return denial(REPLAY_TOO_BIG(loc()));
    plan = p;
  }

  const grantContext: Pick<WorkflowContext, "grant" | "onProfileDenied" | "grantRequiredMessage" | "sources"> = {
    sources: declaration.sources,
    async grant() {
      const a = (await readGrants(actionsFolder))[id];
      return grantValid(declaration, a) ? { profile: a.profile } : null;
    },
    async onProfileDenied() {
      // Data first: until it is gone, the grant still guards it (a crash in between leaves it guarded).
      await deleteDataAction(actionsFolder, id);
      await removeGrant(actionsFolder, id);
    },
    grantRequiredMessage: actionGrantRequired(declaration, loc()),
  };
  const maxDurationMinutes = declaration.maxDurationMinutes;
  const { issue: outcome, run: execution } = await runWorkflow(
    {
      owner: owner,
      valid: valid,
      filesFolder: action.folder,
      config: null,
      previous: null,
      // A trial neither receives nor keeps any memory.
      memory: plan ? {} : await readMemory(dataFolder),
      ...grantContext,
      ...codeCheck(actionsFolder, id, declaration, loc()),
      unrestricted: await readsUnrestricted(actionsFolder, id, declaration),
      trigger: o.trigger,
      ...(plan ? { replay: { reruns: plan.reruns, outputs: plan.outputs, resumed: plan.resumed } } : {}),
      ...(maxDurationMinutes !== undefined ? { maxDurationMinutes: maxDurationMinutes } : {}),
      ...(input !== null ? { input: input } : {}),
      progress: true,
      signal: o.signal,
    },
    {
      engine: o.engine,
      workshop: o.workshop,
      ...(o.launch ? { launch: o.launch } : {}),
      ai: o.ai,
      bridge: o.bridge,
      clock: clock,
      ...(o.locale ? { locale: o.locale } : {}),
      onTrace: (t) => o.onTrace({ ...t, ...(blockTypes.has(t.block) ? { type: blockTypes.get(t.block)! } : {}) }),
      ...(o.localAddresses ? { localAddresses: true } : {}),
      ...(o.pacing ? { pacing: o.pacing } : {}),
      ...(o.searchUrl !== undefined ? { searchUrl: o.searchUrl } : {}),
    },
  );
  if (outcome.t === "stop" && outcome.error === REPLAY_TOO_BIG(loc())) return denial(REPLAY_TOO_BIG(loc()));
  if (plan && o.attempt) {
    execution.id = attemptId(execution.start);
    execution.attempt = { start: o.attempt.start, origin: plan.origin };
  }

  const removedGrant = async () => declaration.sources.account.length > 0 && !grantValid(declaration, (await readGrants(actionsFolder))[id]);
  const present = async () => (await readAction(paths, id)) !== null;
  // What this run wrote: only what can be taken back if the action disappeared in the meantime.
  let runWritten = false;
  let writtenResult = false;
  const keepRun = async () => {
    await writeRun(dataFolder, execution, loc());
    runWritten = true;
  };
  /**
   * What was read with the account goes with the grant (the whole history). An action not found (deleted, or actions folder
   * unmounted for a while, unreadable…) keeps nothing of this run, but its history stays: erasing it
   * is up to `oublierActionsDisparues`, at startup, which can recognize an absent actions folder.
   */
  const lost = async (): Promise<LaunchResult | null> => {
    if (await removedGrant()) {
      await deleteDataAction(actionsFolder, id);
      return { status: "grant-required", error: denialMessage(outcome, declaration, loc()), kernelError: true };
    }
    if (!(await present())) {
      await forgetThisRun(dataFolder, execution.id, { run: runWritten, result: writtenResult });
      return denial(ACTION_UNKNOWN(loc()));
    }
    return null;
  };
  const before = await lost();
  if (before) return before;

  const conclusion = (): LaunchResult => ({
    status: execution.status,
    run: execution.id,
    ...(execution.error !== undefined ? { error: execution.error } : {}),
    ...(execution.kernelError ? { kernelError: true as const } : {}),
  });

  if (outcome.t !== "end") {
    if (o.interrupted?.() === true && execution.status !== "grant-required") markInterrupted(execution, loc());
    await keepRun();
    return (await lost()) ?? conclusion();
  }

  o.onStep("layout");
  const results = outcome.output.value;
  const catalog = [...BUILTIN_COMPONENTS, ...(await readAgentComponents(paths.components)).valid];
  const page = await layOut({
    results: results,
    prompt: declaration.layout ?? null,
    catalog: catalog,
    ai: o.ai,
    signal: o.signal,
    locale: loc(),
    ...(o.layoutDelayMs !== undefined ? { delayMs: o.layoutDelayMs } : {}),
  });
  const pending = await lost();
  if (pending) return pending;
  // Ressac stops during the layout: the run is interrupted, with no result or memory. (The user's « Stop »,
  // on the other hand, keeps the result with the fallback layout.)
  if (o.interrupted?.() === true) {
    markInterrupted(execution, loc());
    await keepRun();
    return (await lost()) ?? conclusion();
  }

  await keepRun();
  try {
    await writeResult(actionsFolder, id, { version: 1, run: execution.id, input: input, results: results, plan: page.plan, fallback: page.fallback, empty: page.empty });
    writtenResult = true;
  } catch (e) {
    // Too big (or disk): the run fails kernel-side, with no result.
    console.error(`[ressac] result of action ${id}:`, message(e));
    execution.status = "failed";
    execution.error = RESULT_TOO_BIG(loc());
    execution.kernelError = true;
    await keepRun();
    return (await lost()) ?? conclusion();
  }
  const afterResult = await lost();
  if (afterResult) return afterResult;

  if (!plan && outcome.memory) {
    // Re-read under the memory lock: a deletion that slipped in since does not leave it written (the erasure
    // of the action's data goes through this same lock).
    const kept = await withMemory(
      dataFolder,
      async () => (await removedGrant()) || !(await present()) || (await writeMemory(dataFolder, outcome.memory!)),
    );
    if (!kept) {
      execution.blocks.find((b) => b.id === valid.output.id)?.log.push(MEMORY_NOT_KEPT(loc()));
      await keepRun();
    }
  }
  return (await lost()) ?? conclusion();
}

/** Removes the run and result written by this run only (same paths as `executions.ts` and `data.ts`). */
async function forgetThisRun(dataFolder: string, execution: string, written: { run: boolean; result: boolean }): Promise<void> {
  if (!ID_EXECUTION.test(execution)) return;
  if (written.result) await rm(join(dataFolder, "results", `${execution}.json`), { force: true }).catch(() => {});
  if (written.run) await rm(join(dataFolder, "runs", `${execution}.json`), { force: true }).catch(() => {});
}

/** The message of an action waiting for a new grant: the engine's if it stopped for that (profile denied…). */
function denialMessage(outcome: WorkflowOutcome, d: DeclarationAction, locale: string): string {
  return outcome.t === "stop" && outcome.status === "grant-required" ? outcome.error : actionGrantRequired(d, locale);
}

