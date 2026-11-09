import type { DirectWidget, DirectState, Execution, AttemptResult, ResumeExecution } from "@webaios/kernel";
import type { ApiWebaios } from "../../shared/api";
import { isActionKey } from "./target";

export type SourceExecutions = Pick<ApiWebaios["home"], "runs" | "run">;
/**
 * « ▶ Lancer », « Rejouer depuis ce bloc » and live tracking, addressed by the workflow's key (`targetKey`). `launch`
 * returns an action's refusal (`error`); a widget's never returns one.
 */
export type Launcher = {
  launch(key: string, input?: string | null): Promise<{ run?: string; error?: string }>;
  replay(key: string, execution: string, block: string): Promise<AttemptResult>;
  direct(): Promise<DirectState>;
  onLive(callback: (e: DirectState) => void): () => void;
};

/** The prefix of the kernel's refusals, reused for a request that fails on the way. */
const REPLAY_PREFIX = "Rejeu impossible : ";

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The user's choice, per widget and per window: changing tab does not lose it. */
const choice = new Map<string, string>();

/** Forgets the choice of widgets no longer on home (an action's, key `action:<id>`, stays). */
export function forgetRunChoices(presents: Iterable<string>): void {
  const ids = new Set(presents);
  for (const id of [...choice.keys()]) if (!ids.has(id) && !isActionKey(id)) choice.delete(id);
}

/**
 * The widget's runs in the builder and the chosen one (badges, « Bloc » tab, preview): by default the latest real
 * run (not a trial); after « Lancer », the new one; after « Rejouer », the trial. Choosing writes nothing.
 */
export class Executions {
  list = $state.raw<ResumeExecution[]>([]);
  /** The user's choice; null: the latest real run. */
  wanted = $state<string | null>(null);
  /** The full chosen run (outputs, logs); null until it is read or if there is none. */
  detail = $state.raw<Execution | null>(null);
  /** The chosen run could not be read (evicted between the list and the detail, or error). */
  notFound = $state(false);
  /** What is running right now (all widgets together, one run per lane) and what waits in the queues. */
  direct = $state.raw<DirectState>({ running: [], waiting: [] });
  /** The latest refusal of « Rejouer » (or « Lancer » for an action), as text. */
  denial = $state<string | null>(null);
  /** A « Lancer » or « Rejouer » request from this builder has not answered yet. */
  private request = $state(false);
  readonly chosen: ResumeExecution | null = $derived(
    (this.wanted === null ? undefined : this.list.find((e) => e.id === this.wanted)) ?? this.list.find((e) => !e.attempt) ?? null,
  );
  /** The run (or trial) of this widget that is running right now. */
  readonly live: DirectWidget | null = $derived.by(() => this.direct.running.find((c) => c.widget === this.widget) ?? null);
  /** Only one run at a time per widget: « Lancer » and « Rejouer » wait. */
  readonly busy: boolean = $derived.by(() => this.request || this.live !== null || this.direct.waiting.includes(this.widget));
  private listRequest = 0;
  private detailRequest = 0;

  constructor(
    readonly widget: string,
    private readonly source: SourceExecutions,
    private readonly launcher?: Launcher,
  ) {
    this.wanted = choice.get(widget) ?? null;
  }

  /** Re-reads the list (at opening and on each change of home); a chosen run that disappeared is forgotten. */
  async load(): Promise<void> {
    return this.loadList(true);
  }

  /** Follows the live state; returns what is needed to stop. */
  follow(): () => void {
    if (!this.launcher) return () => {};
    let finished = false;
    // A pushed event is more recent than the initial read: the read never overwrites it.
    let received = false;
    const end = this.launcher.onLive((e) => {
      received = true;
      this.applyDirect(e);
    });
    void this.launcher
      .direct()
      .then((e) => !finished && !received && this.applyDirect(e))
      .catch(() => {});
    return () => {
      finished = true;
      end();
    };
  }

  /**
   * Unfinished blocks are not relayed at the end of a run: when this widget's run stops (or gives way to the next
   * one), the view realigns on the written run instead of keeping « en cours » badges.
   */
  private applyDirect(e: DirectState): void {
    const before = this.live;
    this.direct = e;
    const after = this.live;
    if (before && (!after || after.start !== before.start || after.kind !== before.kind)) void this.load().catch(() => {});
  }

  /** `review`: a missing detail makes the list be re-read once (the run is probably gone). */
  private async loadList(reread: boolean): Promise<void> {
    const n = ++this.listRequest;
    const l = await this.source.runs(this.widget);
    if (n !== this.listRequest) return;
    if (!sameJson(l, this.list)) this.list = l;
    // Another builder of this widget in the window (tab left during « Lancer ») may have changed the choice.
    const kept = choice.get(this.widget) ?? null;
    if (kept !== this.wanted) this.wanted = kept;
    if (this.wanted !== null && !l.some((e) => e.id === this.wanted)) this.keep(null);
    if (!(await this.loadDetail()) && reread) await this.loadList(false);
  }

  async choose(id: string | null): Promise<void> {
    this.keep(id);
    this.denial = null;
    if (!(await this.loadDetail())) await this.loadList(false);
  }

  private keep(id: string | null): void {
    this.wanted = id;
    if (id === null) choice.delete(this.widget);
    else choice.set(this.widget, id);
  }

  /**
   * « ▶ Lancer » (with an action's input): a real run, chosen when it ends; without a returned id (agent stopped,
   * action refusal, shown), the choice stays. If it is the latest real one, the choice goes back to the default: the
   * following runs take it over.
   */
  async launch(input?: string | null): Promise<void> {
    if (!this.launcher || this.busy) return;
    this.request = true;
    this.denial = null;
    let execution: string | undefined;
    try {
      const r = input === undefined ? await this.launcher.launch(this.widget) : await this.launcher.launch(this.widget, input);
      execution = r.run;
      if (execution !== undefined) this.keep(execution);
      else if (r.error) this.denial = r.error;
    } catch (e) {
      console.error(`[webaios] exécution du widget ${this.widget} :`, e);
    } finally {
      this.request = false;
    }
    await this.load();
    if (execution !== undefined && this.wanted === execution && this.list.find((e) => !e.attempt)?.id === execution) this.keep(null);
  }

  /** « Rejouer depuis ce bloc » with the upstream outputs of the chosen run; the returned trial is chosen. */
  async replay(block: string): Promise<void> {
    const origin = this.chosen;
    if (!this.launcher || this.busy || !origin) return;
    this.request = true;
    this.denial = null;
    try {
      const r = await this.launcher.replay(this.widget, origin.id, block);
      if (r.ok) this.keep(r.run);
      else this.denial = r.error;
    } catch (e) {
      this.denial = REPLAY_PREFIX + ((e as Error)?.message || "erreur inattendue");
    } finally {
      this.request = false;
    }
    await this.load();
  }

  /** false: the chosen run's detail could not be read (`not-found`). */
  private async loadDetail(): Promise<boolean> {
    const r = this.chosen;
    const n = ++this.detailRequest;
    if (!r) {
      this.detail = null;
      this.notFound = false;
      return true;
    }
    // Already read and unchanged (same end, same status): nothing to request again.
    const d = this.detail;
    if (d && d.id === r.id && d.end === r.end && d.status === r.status) return true;
    let e: Execution | null;
    try {
      e = await this.source.run(this.widget, r.id);
    } catch {
      e = null;
    }
    if (n !== this.detailRequest) return true;
    this.detail = e;
    this.notFound = e === null;
    return e !== null;
  }
}
