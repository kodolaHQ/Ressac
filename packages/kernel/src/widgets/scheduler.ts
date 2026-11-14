import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SpacePaths } from "../paths.js";
import { writeWidgetState, readWidgetState, changeWidgetState } from "../home/data.js";
import { readHome } from "../home/read.js";
import type { WidgetState, WidgetRead } from "../home/schemas.js";
import type { Workshop } from "../container/workshop.js";
import type { LocalAi } from "../ai/local-ai.js";
import { createAiDispatcher, type AiDispatcher } from "../ai/dispatcher.js";
import type { BrowserBridge } from "../mcp/bridge.js";
import { readGrants, removeGrant } from "./grants.js";
import { currentSlot, dueHour, trackingAfter, type HourOutcome, type HoursTracking } from "./hours.js";
import type { DirectTrace } from "../workflows/run.js";
import { readRun, type Execution } from "../workflows/executions.js";
import type { Pacing } from "../workflows/pacing.js";
import { notificationText, type NotificationWidget } from "./novelties.js";
import {
  WORKSHOP_STOPPED_ERROR,
  INTERRUPTED_ERROR,
  INTERNAL_HARVEST_ERROR,
  runAttempt,
  runHarvest,
  type HarvestOptions,
  type AttemptResult,
  type HarvestResult,
} from "./harvest.js";

export { WORKSHOP_STOPPED_ERROR, INTERNAL_HARVEST_ERROR, type AttemptResult };

/** A block of the run in progress, from its traces. */
export type DirectBlock = { status: "running" | "succeeded" | "partial" | "failed"; items: number | null };
/** A run (real, or builder try) that is running right now. */
export type DirectWidget = { widget: string; kind: "execution" | "attempt"; start: string; blocks: Record<string, DirectBlock> };
/**
 * `courants`: the runs that are running (one per lane at most, in the order they started). `enAttente`:
 * widgets with a request (manual harvest, try) waiting for its turn.
 */
export type DirectState = { running: DirectWidget[]; waiting: string[] };

/** Beyond this maximum duration (in minutes), a widget runs in the long lane. */
export const LONG_ROUTE_MINUTES = 3;
export type Route = "short" | "long";

/**
 * The watches (`dureeMaxMinutes` > 3) have their own lane: one at a time in the application, without holding back the short
 * widgets, which keep theirs.
 */
export function routeOf(w: WidgetRead): Route {
  if ("error" in w) return "short";
  return (w.declaration.harvest?.maxDurationMinutes ?? 0) > LONG_ROUTE_MINUTES ? "long" : "short";
}

/** Returned by a request whose widget changed lanes while it was waiting. */
class OtherRoute {
  constructor(readonly route: Route) {}
}

const MINUTE = 60_000;
/** A harvest in error is retried at the earliest 15 min after its last attempt. */
const RETRY_ERROR_MS = 15 * MINUTE;
const STOP_WAIT_MS = 15_000;
const ID_WIDGET = /^[a-z0-9-]+$/;

const age = (iso: string | null, now: Date) => (iso ? now.getTime() - Date.parse(iso) : Infinity);

/**
 * Is the widget to be harvested now? It needs a harvest (declared, and `workflow.json` or `harvest.mjs` present), a status other
 * than `accord-requis` (only the user unblocks), and either data older than `recolte.minutes` (or absent), or
 * a fixed hour to do (`heureDue`). After an error, the frequency also waits 15 min since the last
 * attempt. `en-cours` is only relaunched at launch (the previous harvest was interrupted), and only if it has a
 * frequency or an hour to do: otherwise, ours is the one running.
 */
export function widgetOf(w: WidgetRead, now: Date, o: { onLaunch: boolean }): boolean {
  if ("error" in w || !w.hasHarvest || !w.declaration.harvest) return false;
  const { minutes, hours: hours } = w.declaration.harvest;
  const { status: status, lastUpdate: lastUpdate, lastAttempt: lastAttempt } = w.state;
  if (status === "grant-required") return false;
  const byHour = hours !== undefined && dueHour(hours, w.state.hours, lastAttempt, now);
  if (status === "running") return o.onLaunch && (minutes !== undefined || byHour);
  if (byHour) return true;
  if (minutes === undefined) return false; // fixed hours only: never due by frequency
  if (age(lastUpdate, now) < minutes * MINUTE) return false;
  return status !== "error" || age(lastAttempt, now) >= RETRY_ERROR_MS;
}

export type Harvester = (o: HarvestOptions) => Promise<HarvestResult>;
export type Tryer = (o: HarvestOptions & { origin: string; start: string }) => Promise<AttemptResult>;

export interface SchedulerOptions {
  /** The shown language, read when a notification is written (default: English). */
  locale?: () => string;
  paths: SpacePaths;
  widgetsFolder: string;
  /** Folder of the workflow engine (`docker/engine`), mounted read-only in the container. */
  engine: string;
  workshop: Pick<Workshop, "state" | "harvestCommand" | "deleteHarvest">;
  bridge: BrowserBridge;
  ai: Pick<LocalAi, "kev" | "gemma"> | null;
  /** The dispatcher of AI calls, shared with the actions; absent: the scheduler creates its own on `ia`. */
  dispatcher?: ReturnType<typeof createAiDispatcher>;
  clock?: () => Date;
  /** Check of the due harvests (every minute by default). */
  intervalMs?: number;
  /** Called after each write of a widget's state or data. */
  onChange?: () => void;
  /** Tests: replaces the real run of the harvest. */
  harvest?: Harvester;
  /** Tests: replaces the real run of a try. */
  harvestAttempt?: Tryer;
  /** Called at each entry and exit of the queue, and at each trace of the run in progress. */
  onLive?: (e: DirectState) => void;
  /** Tests only: the harvests may read local addresses (see HarvestOptions). */
  localAddresses?: boolean;
  /** Pacing of the searches and open reads, shared by all the harvests and all the tries. */
  pacing?: Pacing;
  /** Tests only: the base of the DuckDuckGo searches (see HarvestOptions). */
  searchUrl?: string;
  /**
   * Workshop startup: no check or harvest before its end (otherwise each launch would show a brief
   * « atelier arrêté » while the container starts).
   */
  ready?: Promise<unknown>;
  /** Bounded wait for a harvest in progress at shutdown (15 s by default). */
  stopWaitMs?: number;
  /**
   * End of a real successful run of a `recolte.notifier` widget that has new items. The text is only their
   * number: nothing of the data. An error from the callback is logged, never propagated.
   */
  notify?: (n: NotificationWidget) => void;
}

/**
 * Launches the widgets' harvests in the background as long as the browser is open: one at a time in each lane
 * (short, long), and never two at once for the same widget.
 */
export class WidgetsScheduler {
  private readonly o: SchedulerOptions & { clock: () => Date; intervalMs: number; harvest: Harvester; harvestAttempt: Tryer };
  private timer: NodeJS.Timeout | undefined;
  /** One harvest at a time per lane: each harvest chains onto the previous one of its lane. */
  private files: Record<Route, Promise<unknown>> = { short: Promise.resolve(), long: Promise.resolve() };
  /** Per widget, the last request (waiting or in progress, all lanes): the next one waits for it. */
  private perWidget = new Map<string, Promise<unknown>>();
  /** Per widget, its long-lane requests (or whose lane is not yet chosen) waiting or in progress. */
  private longs = new Map<string, number>();
  private verification: Promise<string[]> | null = null;
  /** Widgets whose harvest is running right now (their turn has come). */
  private runningIds = new Set<string>();
  private stopped = false;
  /** The runs followed live (those that really run, not a check without harvest). */
  private live: DirectWidget[] = [];
  /** AI calls served in turn between the runs; none without AI. */
  private readonly dispatcher: AiDispatcher | null;
  /** Widgets of the queued requests, not yet started (one per request). */
  private pending: string[] = [];
  /** Startup: the workshop ready and the « en-cours » states from before launch reset. Before any run. */
  private startup: Promise<void> | null = null;
  /** Widgets found en-cours at startup (interrupted) and reset, not yet relaunched. */
  private interrupted = new Set<string>();

  constructor(o: SchedulerOptions) {
    // `??` rather than a spread: an option explicitly passed as undefined keeps its default value.
    this.o = {
      ...o,
      clock: o.clock ?? (() => new Date()),
      intervalMs: o.intervalMs ?? MINUTE,
      harvest: o.harvest ?? runHarvest,
      harvestAttempt: o.harvestAttempt ?? runAttempt,
    };
    this.dispatcher = o.dispatcher ?? (o.ai ? createAiDispatcher(o.ai) : null);
  }

  /** What is running right now, and the requests waiting for their turn. */
  direct(): DirectState {
    // A copy: the caller does not see the tracked state move, and cannot modify it.
    return structuredClone({ running: this.live, waiting: [...new Set(this.pending)] });
  }

  /** An error from the callback must never stop a run. */
  private signalDirect(): void {
    if (!this.o.onLive) return;
    try {
      this.o.onLive(this.direct());
    } catch (e) {
      console.error("[ressac] suivi en direct :", e);
    }
  }

  /** A request enters the queue; `commencee` takes it out when its turn comes. */
  private request(id: string): { started(): void } {
    this.pending.push(id);
    this.signalDirect();
    let done = false;
    return {
      started: () => {
        if (done) return;
        done = true;
        const i = this.pending.indexOf(id);
        if (i >= 0) this.pending.splice(i, 1);
        this.signalDirect();
      },
    };
  }

  /**
   * Follows live the run `f` of widget `widget`. Synchronous: the engine only catches the errors thrown right
   * away by the traces relay. At the end, the blocks are taken from the written run (a block started without an end has
   * no end trace), then nothing is in progress any more.
   */
  private async follow<T>(
    widget: string,
    kind: DirectWidget["kind"],
    f: (onTrace: (t: DirectTrace) => void, ai: HarvestOptions["ai"]) => Promise<T>,
    runOf: (r: T) => string | undefined,
  ): Promise<T> {
    const tracking: DirectWidget = { widget, kind: kind, start: this.o.clock().toISOString(), blocks: {} };
    this.live = [...this.live, tracking];
    this.signalDirect();
    const onTrace = (t: DirectTrace) => {
      // The `avancement` and `lecture` traces (for the actions) change nothing in a widget's tracking.
      if (!this.live.includes(tracking) || (t.step !== "start" && t.step !== "end")) return;
      tracking.blocks[t.block] = t.step === "start" ? { status: "running", items: null } : { status: t.status, items: t.items };
      this.signalDirect();
    };
    // Each run has its own queue of AI calls.
    const ai = this.dispatcher?.for(`${widget}:${tracking.start}`) ?? null;
    let r: T | undefined;
    try {
      r = await f(onTrace, ai);
      return r;
    } finally {
      // Its calls still in the queue no longer go out: they would take the place of the other runs.
      ai?.forget();
      await this.resync(tracking, r === undefined ? undefined : runOf(r));
      this.live = this.live.filter((x) => x !== tracking);
      this.signalDirect();
    }
  }

  private async resync(tracking: DirectWidget, execution: string | undefined): Promise<void> {
    const e = execution ? await readRun(join(this.o.widgetsFolder, tracking.widget), execution).catch(() => null) : null;
    if (e) {
      const blocks: Record<string, DirectBlock> = {};
      for (const b of e.blocks) {
        if (b.start === null) continue;
        const status = b.status === "succeeded" || b.status === "partial" ? b.status : "failed";
        blocks[b.id] = { status: status, items: b.items };
      }
      tracking.blocks = blocks;
    } else {
      // Nothing written (denial, grant withdrawn…): a block still in progress will not finish.
      for (const b of Object.values(tracking.blocks)) if (b.status === "running") b.status = "failed";
    }
    if (this.live.includes(tracking)) this.signalDirect();
  }

  /** Checks at launch, in the background (a harvest takes time), then at regular intervals. */
  async start(): Promise<void> {
    this.inBackground({ onLaunch: true });
    this.timer = setInterval(() => this.inBackground({ onLaunch: false }), this.o.intervalMs);
  }

  /** A background error must never bring the browser down. */
  private inBackground(o: { onLaunch: boolean }): void {
    this.check(o).catch((e) => console.error("[ressac] widgets harvest:", e));
  }

  /**
   * Launches the due harvests; returns the harvested ids in the short lane. Only one check at a time. It never waits
   * for a watch: a due long harvest is launched without being waited for, and a widget that has a long request
   * waiting or in progress is left for the next check.
   */
  async check(o: { onLaunch: boolean }): Promise<string[]> {
    if (this.verification || this.stopped) return [];
    this.verification = this.checkNow(o).finally(() => (this.verification = null));
    return this.verification;
  }

  private async widgets(): Promise<WidgetRead[]> {
    return (await readHome(this.o.paths, this.o.widgetsFolder)).widgets;
  }

  /** The widget's lane from its declaration read now (short if unknown or unreadable). */
  private async currentRoute(id: string): Promise<Route> {
    const w = (await this.widgets().catch(() => [])).find((x) => x.id === id);
    return w ? routeOf(w) : "short";
  }

  /**
   * Runs `f` for widget `id` in the lane of its declaration, read when the widget's turn comes (before entering
   * a lane), then read again under the lane's lock. If it changed while waiting for the lane, the request
   * goes into the other one without losing its turn in the widget.
   */
  private inItsLane<T>(id: string, f: (w: WidgetRead | undefined) => Promise<T>): Promise<T> {
    return this.only(id, "pick", async (route): Promise<T | OtherRoute> => {
      const w = (await this.widgets()).find((x) => x.id === id);
      if (w && routeOf(w) !== route) return new OtherRoute(routeOf(w));
      return f(w);
    });
  }

  /** Every run waits for it: nothing runs before the end of startup. */
  private waitReady(): Promise<void> {
    this.startup ??= Promise.all([this.o.ready?.catch(() => {}), this.restoreInterrupted()]).then(() => {});
    return this.startup;
  }

  /**
   * Before any run, nothing is running: an « en-cours » state comes from an interrupted run (abrupt stop). It is
   * reset, whether relaunched or not (no « 7 / 12 » stays frozen): status and error from before the run (`avant`, ok
   * by default; never accord-requis, the run took place after the grant), dates and hour tracking kept, no more
   * progress. The launch check still relaunches it if it is due as an en-cours widget (`du`).
   */
  private async restoreInterrupted(): Promise<void> {
    const { widgetsFolder: widgetsFolder } = this.o;
    const folders = await readdir(widgetsFolder, { withFileTypes: true }).catch(() => []);
    let change = false;
    for (const d of folders) {
      if (!d.isDirectory() || !ID_WIDGET.test(d.name)) continue;
      const restored = await changeWidgetState(widgetsFolder, d.name, (e) => {
        if (e.status !== "running") return null;
        const before = e.before && e.before.status !== "running" && e.before.status !== "grant-required" ? e.before : { status: "ok" as const };
        return { ...before, lastUpdate: e.lastUpdate, lastAttempt: e.lastAttempt, ...(e.hours ? { hours: e.hours } : {}) };
      }).catch((e) => {
        console.error(`[ressac] state of widget ${d.name}:`, e);
        return null;
      });
      if (!restored) continue;
      this.interrupted.add(d.name);
      change = true;
    }
    if (!change) return;
    // A callback that throws must not block startup (all the runs wait for it).
    try {
      this.o.onChange?.();
    } catch (e) {
      console.error("[ressac] states reset at startup:", e);
    }
  }

  /** `widgetDu`, where a widget reset at startup counts, at launch, as still en-cours. */
  private isDue(w: WidgetRead, o: { onLaunch: boolean }): boolean {
    const interrupted = o.onLaunch && this.interrupted.has(w.id) && !("error" in w) && w.state.status !== "grant-required";
    return widgetOf(interrupted ? { ...w, state: { ...w.state, status: "running" } } : w, this.o.clock(), o);
  }

  private async checkNow(o: { onLaunch: boolean }): Promise<string[]> {
    await this.waitReady();
    if (this.stopped) return [];
    await this.chain("short", () => this.forgetMissingWidgets());
    // The long ones first: launched without being waited for, they do not stay behind the short ones of this check.
    const due = (await this.widgets())
      .filter((w) => this.isDue(w, o))
      .sort((a, b) => Number(routeOf(b) === "long") - Number(routeOf(a) === "long"));
    if (!due.length) return [];
    const harvests: string[] = [];
    for (const entry of due) {
      if (this.stopped) break;
      const { id } = entry;
      if (this.longs.has(id)) continue;
      const route = routeOf(entry);
      // Read again under the lock: a harvest requested in the meantime may have updated it.
      const task = this.only(id, route, async () => {
        const w = (await this.widgets()).find((x) => x.id === id);
        if (!w || !this.isDue(w, o) || this.stopped) return false;
        // Moved to the other lane since the read: the next check will launch it there.
        if (routeOf(w) !== route) return false;
        if (!(await this.workshopStarted())) {
          await this.markWorkshopStopped(w);
          return false;
        }
        if (this.stopped) return false;
        await this.harvest(w, "scheduled");
        return true;
      });
      if (route === "long") {
        task.catch((e) => console.error(`[ressac] harvest of widget ${id}:`, e));
        continue;
      }
      if (await task) harvests.push(id);
    }
    return harvests;
  }

  /**
   * A widget whose folder disappeared loses its grant and its data (state included): recreated later under the same
   * id, it inherits neither the user's consent nor what was read with it. Nothing is erased if the widgets folder
   * itself is missing (unreadable workspace or not yet created).
   */
  private async forgetMissingWidgets(): Promise<void> {
    if (!existsSync(this.o.paths.widgets)) return;
    // A widget that has a request waiting or in progress, in either lane, is left for the next
    // check (a watch, in the other lane, may still write in its folder).
    const presents = new Set([...(await this.widgets()).map((w) => w.id), ...this.perWidget.keys()]);
    const { widgetsFolder: widgetsFolder } = this.o;
    let change = false;
    for (const id of Object.keys(await readGrants(widgetsFolder))) {
      if (presents.has(id)) continue;
      await removeGrant(widgetsFolder, id);
      change = true;
    }
    const folders = await readdir(widgetsFolder, { withFileTypes: true }).catch(() => []);
    for (const d of folders) {
      if (!d.isDirectory() || !ID_WIDGET.test(d.name) || presents.has(d.name)) continue;
      await rm(join(widgetsFolder, d.name), { recursive: true, force: true });
      change = true;
    }
    if (change) this.o.onChange?.();
  }

  /**
   * Marks `id` as the harvest in progress as soon as its turn comes (before any wait), so that a stop at any
   * moment knows which container to remove.
   */
  private async running<T>(id: string, f: () => Promise<T>): Promise<T> {
    this.runningIds.add(id);
    try {
      return await f();
    } finally {
      this.runningIds.delete(id);
    }
  }

  private chain<T>(route: Route, f: () => Promise<T>): Promise<T> {
    const next = this.files[route].catch(() => {}).then(f);
    this.files[route] = next;
    return next;
  }

  private countLong(id: string, d: 1 | -1): void {
    const n = (this.longs.get(id) ?? 0) + d;
    if (n > 0) this.longs.set(id, n);
    else this.longs.delete(id);
  }

  /**
   * Runs `f` for widget `id`, after the end of any previous request of this widget, whatever its lane
   * (`dureeMaxMinutes` may have changed while it was running). Its place is taken right away: the order of a
   * widget's requests is kept. The request only enters its lane once the widget is free: it does not hold the other
   * widgets there while waiting. `"pick"`: the lane is read at that moment; if `f` returns `OtherRoute` (changed during
   * the wait for the lane), the request goes into the other one, still at its turn in the widget.
   */
  private only<T>(id: string, route: Route | "pick", f: (route: Route) => Promise<T | OtherRoute>): Promise<T> {
    // A request whose lane is not yet chosen counts as long: a check does not wait for it.
    let counted = route !== "short";
    if (counted) this.countLong(id, 1);
    const previous = this.perWidget.get(id) ?? Promise.resolve();
    const task = previous.then(async () => {
      try {
        let v = route === "pick" ? await this.currentRoute(id) : route;
        for (;;) {
          if (counted !== (v === "long")) {
            counted = v === "long";
            this.countLong(id, counted ? 1 : -1);
          }
          const planned = v;
          const r = await this.chain(planned, () => this.running(id, () => f(planned)));
          if (!(r instanceof OtherRoute)) return r;
          v = r.route;
        }
      } finally {
        if (counted) this.countLong(id, -1);
        counted = false;
      }
    });
    const end = task.catch(() => {});
    this.perWidget.set(id, end);
    void end.then(() => {
      if (this.perWidget.get(id) === end) this.perWidget.delete(id);
    });
    return task;
  }

  private async workshopStarted(): Promise<boolean> {
    return (await this.o.workshop.state().catch(() => "absent")) === "demarre";
  }

  /** Without a workshop, nothing runs: the widget keeps its data and says so (a single write). */
  private locale(): string {
    return this.o.locale?.() ?? "en";
  }

  private async markWorkshopStopped(w: WidgetRead): Promise<WidgetState> {
    const before = await readWidgetState(this.o.widgetsFolder, w.id);
    if (before.status === "workshop-stopped") return before;
    const state: WidgetState = {
      status: "workshop-stopped",
      lastUpdate: before.lastUpdate,
      lastAttempt: before.lastAttempt,
      error: WORKSHOP_STOPPED_ERROR(this.locale()),
      kernelError: true,
    };
    await writeWidgetState(this.o.widgetsFolder, w.id, state);
    this.o.onChange?.();
    return state;
  }

  private harvestOptions(w: WidgetRead, onTrace: (t: DirectTrace) => void, ai: HarvestOptions["ai"]): HarvestOptions {
    return {
      id: w.id,
      widget: w,
      widgetsFolder: this.o.widgetsFolder,
      engine: this.o.engine,
      workshop: this.o.workshop,
      ai: ai,
      bridge: this.o.bridge,
      clock: this.o.clock,
      ...(this.o.locale ? { locale: this.o.locale } : {}),
      ...(this.o.onChange ? { onChange: this.o.onChange } : {}),
      ...(this.o.localAddresses ? { localAddresses: true } : {}),
      ...(this.o.pacing ? { pacing: this.o.pacing } : {}),
      ...(this.o.searchUrl !== undefined ? { searchUrl: this.o.searchUrl } : {}),
      interrupted: () => this.stopped,
      onTrace: onTrace,
    };
  }

  /**
   * A real run. For a widget with hours, its outcome is noted in the tracking, for the slot where it started
   * (tries never go through here).
   */
  private async harvest(w: WidgetRead, trigger: Execution["trigger"]): Promise<WidgetState & { run?: string }> {
    const start = this.o.clock();
    this.interrupted.delete(w.id);
    const { result: result, issue: outcome } = await this.run(w, trigger, start);
    const hours = "error" in w ? undefined : w.declaration.harvest?.hours;
    if (!hours) return result;
    const tracking = await this.noteTime(w.id, currentSlot(hours, start), outcome, this.o.clock());
    return tracking ? { ...result, hours: tracking } : result;
  }

  /**
   * Writes the hours tracking on the re-read state (nothing before the day's first hour, nor for a run with no effect).
   * `fin`: the end of the run, from which the wait before a retry counts.
   */
  private async noteTime(id: string, slot: string | null, outcome: HourOutcome, end: Date): Promise<HoursTracking | null> {
    if (!slot || outcome === "no-effect") return null;
    try {
      const state = await changeWidgetState(this.o.widgetsFolder, id, (e) => ({ ...e, hours: trackingAfter(e.hours, slot, outcome, end.toISOString()) }));
      this.o.onChange?.();
      return state?.hours ?? null;
    } catch (e) {
      console.error(`[ressac] hours tracking of widget ${id}:`, e);
      return null;
    }
  }

  private async run(w: WidgetRead, trigger: Execution["trigger"], start: Date): Promise<{ result: WidgetState & { run?: string }; issue: HourOutcome }> {
    const before = await readWidgetState(this.o.widgetsFolder, w.id);
    let state: WidgetState;
    let run: string | undefined;
    let fresh: number | undefined;
    try {
      ({ state: state, run, newItems: fresh } = await this.follow(
        w.id,
        "execution",
        (onTrace, ai) => this.o.harvest({ ...this.harvestOptions(w, onTrace, ai), trigger: trigger }),
        (r) => r.run,
      ));
    } catch (e) {
      // The harvest may have written en-cours before failing (disk, container…): the widget must not stay there. The exception's
      // text is not kept (it may quote what the widget read): only a fixed kernel message is.
      console.error(`[ressac] harvest of widget ${w.id}:`, e);
      state = this.stopped
        ? before
        : // `derniereTentative` is always the start of the attempt, as in the harvest.
          { status: "error", lastUpdate: before.lastUpdate, lastAttempt: start.toISOString(), error: INTERNAL_HARVEST_ERROR(this.locale()), kernelError: true };
      await writeWidgetState(this.o.widgetsFolder, w.id, state);
      this.o.onChange?.();
      return { result: state, issue: this.stopped ? "no-effect" : "failure" };
    }
    // Kernel stop during the harvest (exit, profile change): it did not fail, it will resume later.
    if (this.stopped && state.status === "error") {
      await writeWidgetState(this.o.widgetsFolder, w.id, before);
      this.o.onChange?.();
      return { result: { ...before, ...(run ? { run } : {}) }, issue: "no-effect" };
    }
    if (state.status === "ok" && fresh !== undefined && fresh > 0) this.notifyEnd(w, fresh);
    // Grant required, workshop stopped: the run did not really take place.
    const outcome: HourOutcome = state.status === "ok" ? "succeeded" : state.status === "error" ? "failure" : "no-effect";
    return { result: { ...state, ...(run ? { run } : {}) }, issue: outcome };
  }

  /** End notification: title = widget name, text = number of new items, never anything from the data. */
  private notifyEnd(w: WidgetRead, fresh: number): void {
    if (!this.o.notify || "error" in w || w.declaration.harvest?.notify !== true) return;
    try {
      // `nom` is written by the agent: control and invisible characters replaced, on a single line.
      const title = w.declaration.name.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim() || w.id;
      this.o.notify({ widget: w.id, title: title, text: notificationText(fresh, this.locale()) });
    } catch (e) {
      console.error(`[ressac] notification of widget ${w.id}:`, e);
    }
  }

  /**
   * Harvests this widget right away (after the harvest in progress) and returns its new state, with the id of the written run
   * (none if nothing ran: workshop stopped, kernel stopping, grant withdrawn meanwhile).
   */
  async harvestNow(id: string, trigger: Execution["trigger"] = "manual"): Promise<WidgetState & { run?: string }> {
    const request = this.request(id);
    await this.waitReady();
    try {
      return await this.inItsLane(id, async (w) => {
        request.started();
        if (!w) throw new Error(`Widget inconnu : ${id}`);
        if (this.stopped) return readWidgetState(this.o.widgetsFolder, id);
        if (!(await this.workshopStarted())) return this.markWorkshopStopped(w);
        if (this.stopped) return readWidgetState(this.o.widgetsFolder, id);
        return this.harvest(w, trigger);
      });
    } finally {
      request.started();
    }
  }

  /**
   * Builder try: replays the widget's workflow from `depart` with the upstream outputs of run
   * `origine`, in the same queue as the real runs (the container carries the widget's id). Without a workshop, refused
   * without touching the widget's state.
   */
  async replay(id: string, origin: string, start: string): Promise<AttemptResult> {
    const request = this.request(id);
    await this.waitReady();
    // The try follows its widget's lane.
    try {
      return await this.inItsLane(id, async (w): Promise<AttemptResult> => {
        request.started();
        if (!w) return { ok: false, error: `Widget inconnu : ${id}` };
        if (this.stopped) return { ok: false, error: INTERRUPTED_ERROR(this.locale()) };
        if (!(await this.workshopStarted())) return { ok: false, error: WORKSHOP_STOPPED_ERROR(this.locale()) };
        if (this.stopped) return { ok: false, error: INTERRUPTED_ERROR(this.locale()) };
        try {
          return await this.follow(
            id,
            "attempt",
            (onTrace, ai) => this.o.harvestAttempt({ ...this.harvestOptions(w, onTrace, ai), trigger: "replay", origin: origin, start: start }),
            (r) => (r.ok ? r.run : undefined),
          );
        } catch (e) {
          // The exception's text may quote what the widget read: only a fixed kernel message is returned.
          console.error(`[ressac] trial of widget ${id}:`, e);
          return { ok: false, error: INTERNAL_HARVEST_ERROR(this.locale()) };
        }
      });
    } finally {
      request.started();
    }
  }

  private async deleteContainers(): Promise<void> {
    await Promise.all([...this.runningIds].map((id) => this.o.workshop.deleteHarvest(id).catch(() => {})));
  }

  /**
   * Cuts the timer; the harvests in progress (one per lane at most) are killed in their container and waited for, in a
   * bounded way: an interrupted watch must still write its memory and its « interrompue » run.
   */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.stopped = true;
    await this.deleteContainers();
    // Bounded: quitting the browser must not wait for a harvest that escaped the shutdown.
    const all = Promise.all([this.files.short, this.files.long, ...this.perWidget.values()].map((x) => x.catch(() => {})));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([all, new Promise((ok) => (timer = setTimeout(ok, this.o.stopWaitMs ?? STOP_WAIT_MS)))]);
    clearTimeout(timer);
    // Still not finished: their container may have started after the first removal.
    await this.deleteContainers();
  }
}
