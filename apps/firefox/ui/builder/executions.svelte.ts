import type { DirectWidget, DirectState, Execution, AttemptResult, ResumeExecution } from "@webaios/kernel";
import type { ApiWebaios } from "../../shared/api";
import { isActionKey } from "./target";

export type SourceExecutions = Pick<ApiWebaios["accueil"], "executions" | "execution">;
/**
 * « ▶ Lancer », « Rejouer depuis ce bloc » and live tracking, addressed by the workflow's key (`targetKey`). `lancer`
 * returns an action's refusal (`erreur`); a widget's never returns one.
 */
export type Launcher = {
  lancer(key: string, input?: string | null): Promise<{ execution?: string; erreur?: string }>;
  rejouer(key: string, execution: string, block: string): Promise<AttemptResult>;
  direct(): Promise<DirectState>;
  surDirect(callback: (e: DirectState) => void): () => void;
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
  liste = $state.raw<ResumeExecution[]>([]);
  /** The user's choice; null: the latest real run. */
  voulue = $state<string | null>(null);
  /** The full chosen run (outputs, logs); null until it is read or if there is none. */
  detail = $state.raw<Execution | null>(null);
  /** The chosen run could not be read (evicted between the list and the detail, or error). */
  introuvable = $state(false);
  /** What is running right now (all widgets together, one run per lane) and what waits in the queues. */
  direct = $state.raw<DirectState>({ courants: [], enAttente: [] });
  /** The latest refusal of « Rejouer » (or « Lancer » for an action), as text. */
  refus = $state<string | null>(null);
  /** A « Lancer » or « Rejouer » request from this builder has not answered yet. */
  private demande = $state(false);
  readonly choisie: ResumeExecution | null = $derived(
    (this.voulue === null ? undefined : this.liste.find((e) => e.id === this.voulue)) ?? this.liste.find((e) => !e.essai) ?? null,
  );
  /** The run (or trial) of this widget that is running right now. */
  readonly enDirect: DirectWidget | null = $derived.by(() => this.direct.courants.find((c) => c.widget === this.widget) ?? null);
  /** Only one run at a time per widget: « Lancer » and « Rejouer » wait. */
  readonly occupe: boolean = $derived.by(() => this.demande || this.enDirect !== null || this.direct.enAttente.includes(this.widget));
  private requeteListe = 0;
  private requeteDetail = 0;

  constructor(
    readonly widget: string,
    private readonly source: SourceExecutions,
    private readonly lanceur?: Launcher,
  ) {
    this.voulue = choice.get(widget) ?? null;
  }

  /** Re-reads the list (at opening and on each change of home); a chosen run that disappeared is forgotten. */
  async charger(): Promise<void> {
    return this.chargerListe(true);
  }

  /** Follows the live state; returns what is needed to stop. */
  suivre(): () => void {
    if (!this.lanceur) return () => {};
    let finished = false;
    // A pushed event is more recent than the initial read: the read never overwrites it.
    let received = false;
    const end = this.lanceur.surDirect((e) => {
      received = true;
      this.appliquerDirect(e);
    });
    void this.lanceur
      .direct()
      .then((e) => !finished && !received && this.appliquerDirect(e))
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
  private appliquerDirect(e: DirectState): void {
    const before = this.enDirect;
    this.direct = e;
    const after = this.enDirect;
    if (before && (!after || after.debut !== before.debut || after.genre !== before.genre)) void this.charger().catch(() => {});
  }

  /** `relire`: a missing detail makes the list be re-read once (the run is probably gone). */
  private async chargerListe(reread: boolean): Promise<void> {
    const n = ++this.requeteListe;
    const l = await this.source.executions(this.widget);
    if (n !== this.requeteListe) return;
    if (!sameJson(l, this.liste)) this.liste = l;
    // Another builder of this widget in the window (tab left during « Lancer ») may have changed the choice.
    const kept = choice.get(this.widget) ?? null;
    if (kept !== this.voulue) this.voulue = kept;
    if (this.voulue !== null && !l.some((e) => e.id === this.voulue)) this.garder(null);
    if (!(await this.chargerDetail()) && reread) await this.chargerListe(false);
  }

  async choisir(id: string | null): Promise<void> {
    this.garder(id);
    this.refus = null;
    if (!(await this.chargerDetail())) await this.chargerListe(false);
  }

  private garder(id: string | null): void {
    this.voulue = id;
    if (id === null) choice.delete(this.widget);
    else choice.set(this.widget, id);
  }

  /**
   * « ▶ Lancer » (with an action's input): a real run, chosen when it ends; without a returned id (agent stopped,
   * action refusal, shown), the choice stays. If it is the latest real one, the choice goes back to the default: the
   * following runs take it over.
   */
  async lancer(input?: string | null): Promise<void> {
    if (!this.lanceur || this.occupe) return;
    this.demande = true;
    this.refus = null;
    let execution: string | undefined;
    try {
      const r = input === undefined ? await this.lanceur.lancer(this.widget) : await this.lanceur.lancer(this.widget, input);
      execution = r.execution;
      if (execution !== undefined) this.garder(execution);
      else if (r.erreur) this.refus = r.erreur;
    } catch (e) {
      console.error(`[webaios] exécution du widget ${this.widget} :`, e);
    } finally {
      this.demande = false;
    }
    await this.charger();
    if (execution !== undefined && this.voulue === execution && this.liste.find((e) => !e.essai)?.id === execution) this.garder(null);
  }

  /** « Rejouer depuis ce bloc » with the upstream outputs of the chosen run; the returned trial is chosen. */
  async rejouer(block: string): Promise<void> {
    const origin = this.choisie;
    if (!this.lanceur || this.occupe || !origin) return;
    this.demande = true;
    this.refus = null;
    try {
      const r = await this.lanceur.rejouer(this.widget, origin.id, block);
      if (r.ok) this.garder(r.execution);
      else this.refus = r.erreur;
    } catch (e) {
      this.refus = REPLAY_PREFIX + ((e as Error)?.message || "erreur inattendue");
    } finally {
      this.demande = false;
    }
    await this.charger();
  }

  /** false: the chosen run's detail could not be read (`introuvable`). */
  private async chargerDetail(): Promise<boolean> {
    const r = this.choisie;
    const n = ++this.requeteDetail;
    if (!r) {
      this.detail = null;
      this.introuvable = false;
      return true;
    }
    // Already read and unchanged (same end, same status): nothing to request again.
    const d = this.detail;
    if (d && d.id === r.id && d.fin === r.fin && d.statut === r.statut) return true;
    let e: Execution | null;
    try {
      e = await this.source.execution(this.widget, r.id);
    } catch {
      e = null;
    }
    if (n !== this.requeteDetail) return true;
    this.detail = e;
    this.introuvable = e === null;
    return e !== null;
  }
}
