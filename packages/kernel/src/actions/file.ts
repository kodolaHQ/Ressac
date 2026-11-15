import type { SpacePaths } from "../paths.js";
import type { Workshop } from "../container/workshop.js";
import type { AiDispatcher } from "../ai/dispatcher.js";
import type { BrowserBridge } from "../mcp/bridge.js";
import { WORKSHOP_STOPPED_ERROR, INTERRUPTED_ERROR } from "../widgets/harvest.js";
import type { ProcessLauncher } from "../workflows/run.js";
import { ACTION_STOPPED, type Execution } from "../workflows/executions.js";
import { say } from "../i18n.js";
import type { Pacing } from "../workflows/pacing.js";
import { cutInput, runAction, type OptionsAction, type LaunchResult, type TraceAction } from "./run.js";

/** Different actions running at the same time, at most. */
export const CONCURRENT_ACTIONS = 2;
export const INTERNAL_ACTION_ERROR = (locale: string) => say(locale, "kernel-err-action-internal");
const STOP_WAIT_MS = 15_000;

/** A running action, from its traces: what its page shows during the run. */
export type DirectAction = {
  action: string;
  start: string;
  input: string | null;
  attempt: boolean;
  step: "workflow" | "layout";
  /** `type`: that of the block in the workflow (its label is the catalog's). */
  blocks: Record<string, { status: "running" | "succeeded" | "partial" | "failed"; items: number | null; done?: number; total?: number; host?: string; type?: string }>;
};
export type ActionsState = { running: DirectAction[]; waiting: { action: string; since: string }[] };
/** `deja`: the action was already running (or waiting); `fin` is that of this run. */
export type ActionLaunch = { already: boolean; end: Promise<LaunchResult> };
export type { LaunchResult };

export interface OptionsFileActions {
  /** The shown language, read when an error is written (default: English). */
  locale?: () => string;
  paths: SpacePaths;
  actionsFolder: string;
  engine: string;
  workshop: Pick<Workshop, "state" | "harvestCommand" | "deleteHarvest">;
  launch?: ProcessLauncher;
  bridge: BrowserBridge;
  /** The dispatcher shared with the widgets; null without local AI. */
  dispatcher: Pick<AiDispatcher, "for"> | null;
  clock?: () => Date;
  /** Workshop start: no action leaves before. */
  ready?: Promise<unknown>;
  /** Called on each change of `direct()`; must return control right away. */
  onLive?: (e: ActionsState) => void;
  localAddresses?: boolean;
  pacing?: Pacing;
  searchUrl?: string;
  layoutDelayMs?: number;
  /** Bounded wait for running actions at shutdown (15 s by default). */
  stopWaitMs?: number;
  /** Tests: replaces the real run of an action. */
  run?: (o: OptionsAction) => Promise<LaunchResult>;
}

type Request = {
  id: string;
  input: string | null;
  trigger: Execution["trigger"];
  attempt: { origin: string; start: string } | null;
  ctl: AbortController;
  end: Promise<LaunchResult>;
  since: string;
  /** Present while waiting for a slot: grants it (true) or gives up (false). */
  place?: (ok: boolean) => void;
  direct?: DirectAction;
};

/**
 * The actions queue, apart from that of widget harvests (an action never waits for a harvest): at most
 * `CONCURRENT_ACTIONS` different actions at the same time, the next ones wait their turn; only one run at a
 * time per action (a request while it runs or waits returns that one).
 */
export class FileActions {
  private readonly o: OptionsFileActions & { clock: () => Date; run: (o: OptionsAction) => Promise<LaunchResult> };
  /** Per action, its pending or running request. */
  private readonly perAction = new Map<string, Request>();
  /** Requests that have a slot (they run), in the order they got it. */
  private running: Request[] = [];
  /** Requests waiting for a slot. */
  private pending: Request[] = [];
  private isStopped = false;

  constructor(o: OptionsFileActions) {
    this.o = { ...o, clock: o.clock ?? (() => new Date()), run: o.run ?? runAction };
  }

  launch(id: string, o: { input: string | null; trigger: Execution["trigger"] }): ActionLaunch {
    return this.ask(id, { input: cutInput(o.input), trigger: o.trigger, attempt: null });
  }

  /** Builder trial: replays from `depart` with the upstream outputs of run `origine`. */
  try(id: string, origin: string, start: string): ActionLaunch {
    return this.ask(id, { input: null, trigger: "replay", attempt: { origin: origin, start: start } });
  }

  /** Stops this action's run (or removes it from the queue); false if it neither runs nor waits. */
  stop(id: string): boolean {
    const d = this.perAction.get(id);
    if (!d) return false;
    d.ctl.abort();
    if (d.place) {
      this.pending = this.pending.filter((x) => x !== d);
      d.place(false);
      this.signalDirect();
    }
    return true;
  }

  direct(): ActionsState {
    // A copy: the caller does not see the tracked state move, and cannot modify it.
    return structuredClone({
      running: this.running.flatMap((d) => (d.direct ? [d.direct] : [])),
      waiting: this.pending.map((d) => ({ action: d.id, since: d.since })),
    });
  }

  /**
   * Kernel shutdown: all actions are stopped (those running write an « interrupted » run),
   * their containers deleted, and they are awaited in a bounded way. Nothing leaves afterwards.
   */
  async stopAll(): Promise<void> {
    this.isStopped = true;
    const ends = [...this.perAction.values()].map((d) => d.end.catch(() => {}));
    for (const id of [...this.perAction.keys()]) this.stop(id);
    await this.deleteContainers();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(ends), new Promise((ok) => (timer = setTimeout(ok, this.o.stopWaitMs ?? STOP_WAIT_MS)))]);
    clearTimeout(timer);
    // Still not finished: their container may have started after the first deletion.
    await this.deleteContainers();
  }

  private async deleteContainers(): Promise<void> {
    await Promise.all(this.running.map((d) => this.o.workshop.deleteHarvest({ type: "action", id: d.id }).catch(() => {})));
  }

  private ask(id: string, o: Pick<Request, "input" | "trigger" | "attempt">): ActionLaunch {
    const existing = this.perAction.get(id);
    // A try and a real run never stand for each other: the second one starts once the first has ended.
    if (existing && (existing.attempt === null) !== (o.attempt === null)) {
      return { already: false, end: existing.end.catch(() => undefined).then(() => this.ask(id, o).end) };
    }
    if (existing) return { already: true, end: existing.end };
    if (this.isStopped) return { already: false, end: Promise.resolve(this.stopped()) };
    const d: Request = { id, ...o, ctl: new AbortController(), end: Promise.resolve(this.stopped()), since: this.o.clock().toISOString() };
    // The request leaves the map before its end is returned: a request made after the end starts again.
    d.end = this.unroll(d).finally(() => {
      if (this.perAction.get(id) === d) this.perAction.delete(id);
    });
    this.perAction.set(id, d);
    return { already: false, end: d.end };
  }

  private locale(): string {
    return this.o.locale?.() ?? "en";
  }

  /** Stopped before running: nothing is written. */
  private stopped(): LaunchResult {
    return { status: "interrupted", error: this.isStopped ? INTERRUPTED_ERROR(this.locale()) : ACTION_STOPPED(this.locale()), kernelError: true };
  }

  private async unroll(d: Request): Promise<LaunchResult> {
    try {
      await this.o.ready?.catch(() => {});
      if (this.isStopped || d.ctl.signal.aborted) return this.stopped();
      if (!(await this.place(d))) return this.stopped();
      try {
        return await this.run(d);
      } finally {
        this.release(d);
      }
    } catch (e) {
      // The exception text may quote what the action read: only a fixed kernel message is returned.
      console.error(`[ressac] action ${d.id} :`, e);
      return { status: "failed", error: INTERNAL_ACTION_ERROR(this.locale()), kernelError: true };
    }
  }

  /** Takes a slot, or waits for its own; false if the request is stopped in the meantime. */
  private place(d: Request): Promise<boolean> {
    if (this.running.length < CONCURRENT_ACTIONS) {
      this.running.push(d);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((ok) => {
      d.since = this.o.clock().toISOString();
      d.place = (yes) => {
        delete d.place;
        ok(yes);
      };
      this.pending.push(d);
      this.signalDirect();
    });
  }

  private release(d: Request): void {
    this.running = this.running.filter((x) => x !== d);
    const next = this.pending.shift();
    if (next) {
      this.running.push(next);
      next.place?.(true);
    }
    this.signalDirect();
  }

  private async run(d: Request): Promise<LaunchResult> {
    const start = this.o.clock().toISOString();
    const tracking: DirectAction = { action: d.id, start: start, input: d.input, attempt: d.attempt !== null, step: "workflow", blocks: {} };
    d.direct = tracking;
    this.signalDirect();
    if ((await this.o.workshop.state().catch(() => "absent")) !== "demarre") {
      return { status: "failed", error: WORKSHOP_STOPPED_ERROR(this.locale()), kernelError: true };
    }
    const onTrace = (t: TraceAction) => {
      if (d.direct !== tracking) return;
      const b = tracking.blocks[t.block];
      if (t.step === "start") tracking.blocks[t.block] = { status: "running", items: null };
      else if (t.step === "end") tracking.blocks[t.block] = { status: t.status, items: t.items };
      else if (t.step === "progress") tracking.blocks[t.block] = { ...(b ?? { status: "running", items: null }), done: t.done, total: t.total };
      else tracking.blocks[t.block] = { ...(b ?? { status: "running", items: null }), host: t.host };
      if (t.type !== undefined) tracking.blocks[t.block]!.type = t.type;
      this.signalDirect();
    };
    const onStep = (e: "layout") => {
      if (d.direct !== tracking) return;
      tracking.step = e;
      this.signalDirect();
    };
    // Each run has its own queue of AI calls, served before those of widgets.
    const ai = this.o.dispatcher?.for(`action:${d.id}:${start}`, { priority: true }) ?? null;
    try {
      return await this.o.run({
        id: d.id,
        paths: this.o.paths,
        actionsFolder: this.o.actionsFolder,
        engine: this.o.engine,
        workshop: this.o.workshop,
        ...(this.o.launch ? { launch: this.o.launch } : {}),
        bridge: this.o.bridge,
        ...(this.o.locale ? { locale: this.o.locale } : {}),
        ai: ai,
        clock: this.o.clock,
        input: d.input,
        trigger: d.trigger,
        signal: d.ctl.signal,
        onTrace: onTrace,
        onStep: onStep,
        ...(d.attempt ? { attempt: d.attempt } : {}),
        interrupted: () => this.isStopped,
        ...(this.o.localAddresses ? { localAddresses: true } : {}),
        ...(this.o.pacing ? { pacing: this.o.pacing } : {}),
        ...(this.o.searchUrl !== undefined ? { searchUrl: this.o.searchUrl } : {}),
        ...(this.o.layoutDelayMs !== undefined ? { layoutDelayMs: this.o.layoutDelayMs } : {}),
      });
    } finally {
      // Its calls still queued no longer leave: they would take the place of other runs.
      ai?.forget();
      delete d.direct;
    }
  }

  /** An error from the callback must never stop a run. */
  private signalDirect(): void {
    if (!this.o.onLive) return;
    try {
      this.o.onLive(this.direct());
    } catch (e) {
      console.error("[ressac] actions tracking:", e);
    }
  }
}
