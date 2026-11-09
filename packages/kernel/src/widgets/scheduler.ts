import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SpacePaths } from "../paths.js";
import { writeWidgetState, readWidgetState, changeWidgetState } from "../home/data.js";
import { readHome } from "../home/lire.js";
import type { WidgetState, WidgetLu } from "../home/schemas.js";
import type { Workshop } from "../container/workshop.js";
import type { LocalAi } from "../ai/ia-locale.js";
import { createAiDispatcher, type AiDispatcher } from "../ai/dispatcher.js";
import type { BrowserBridge } from "../mcp/pont.js";
import { readGrants, removeGrant } from "./accords.js";
import { currentSlot, dueHour, trackingAfter, type HourOutcome, type HoursTracking } from "./hours.js";
import type { DirectTrace } from "../workflows/executer.js";
import { readRun, type Execution } from "../workflows/executions.js";
import type { Pacing } from "../workflows/pacing.js";
import { notificationText, type NotificationWidget } from "./nouveautes.js";
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
export type DirectBlock = { statut: "en-cours" | "reussi" | "partiel" | "echoue"; elements: number | null };
/** A run (real, or builder try) that is running right now. */
export type DirectWidget = { widget: string; genre: "execution" | "essai"; debut: string; blocs: Record<string, DirectBlock> };
/**
 * `courants`: the runs that are running (one per lane at most, in the order they started). `enAttente`:
 * widgets with a request (manual harvest, try) waiting for its turn.
 */
export type DirectState = { courants: DirectWidget[]; enAttente: string[] };

/** Beyond this maximum duration (in minutes), a widget runs in the long lane. */
export const LONG_ROUTE_MINUTES = 3;
export type Route = "courte" | "longue";

/**
 * The watches (`dureeMaxMinutes` > 3) have their own lane: one at a time in the application, without holding back the short
 * widgets, which keep theirs.
 */
export function routeOf(w: WidgetLu): Route {
  if ("erreur" in w) return "courte";
  return (w.declaration.recolte?.dureeMaxMinutes ?? 0) > LONG_ROUTE_MINUTES ? "longue" : "courte";
}

/** Returned by a request whose widget changed lanes while it was waiting. */
class OtherRoute {
  constructor(readonly voie: Route) {}
}

const MINUTE = 60_000;
/** A harvest in error is retried at the earliest 15 min after its last attempt. */
const RETRY_ERROR_MS = 15 * MINUTE;
const STOP_WAIT_MS = 15_000;
const ID_WIDGET = /^[a-z0-9-]+$/;

const age = (iso: string | null, now: Date) => (iso ? now.getTime() - Date.parse(iso) : Infinity);

/**
 * Is the widget to be harvested now? It needs a harvest (declared, and `workflow.json` or `recolte.mjs` present), a status other
 * than `accord-requis` (only the user unblocks), and either data older than `recolte.minutes` (or absent), or
 * a fixed hour to do (`heureDue`). After an error, the frequency also waits 15 min since the last
 * attempt. `en-cours` is only relaunched at launch (the previous harvest was interrupted), and only if it has a
 * frequency or an hour to do: otherwise, ours is the one running.
 */
export function widgetOf(w: WidgetLu, now: Date, o: { auLancement: boolean }): boolean {
  if ("erreur" in w || !w.aRecolte || !w.declaration.recolte) return false;
  const { minutes, heures: hours } = w.declaration.recolte;
  const { statut: status, derniereMaj: lastUpdate, derniereTentative: lastAttempt } = w.etat;
  if (status === "accord-requis") return false;
  const byHour = hours !== undefined && dueHour(hours, w.etat.heures, lastAttempt, now);
  if (status === "en-cours") return o.auLancement && (minutes !== undefined || byHour);
  if (byHour) return true;
  if (minutes === undefined) return false; // fixed hours only: never due by frequency
  if (age(lastUpdate, now) < minutes * MINUTE) return false;
  return status !== "erreur" || age(lastAttempt, now) >= RETRY_ERROR_MS;
}

export type Harvester = (o: HarvestOptions) => Promise<HarvestResult>;
export type Tryer = (o: HarvestOptions & { origine: string; depart: string }) => Promise<AttemptResult>;

export interface SchedulerOptions {
  chemins: SpacePaths;
  dossierWidgets: string;
  /** Folder of the workflow engine (`docker/moteur`), mounted read-only in the container. */
  moteur: string;
  atelier: Pick<Workshop, "etat" | "commandeRecolte" | "supprimerRecolte">;
  pont: BrowserBridge;
  ia: Pick<LocalAi, "kev" | "gemma"> | null;
  /** The dispatcher of AI calls, shared with the actions; absent: the scheduler creates its own on `ia`. */
  repartiteur?: ReturnType<typeof createAiDispatcher>;
  horloge?: () => Date;
  /** Check of the due harvests (every minute by default). */
  intervalleMs?: number;
  /** Called after each write of a widget's state or data. */
  surChange?: () => void;
  /** Tests: replaces the real run of the harvest. */
  recolter?: Harvester;
  /** Tests: replaces the real run of a try. */
  recolterEssai?: Tryer;
  /** Called at each entry and exit of the queue, and at each trace of the run in progress. */
  surDirect?: (e: DirectState) => void;
  /** Tests only: the harvests may read local addresses (see OptionsRecolte). */
  adressesLocales?: boolean;
  /** Pacing of the searches and open reads, shared by all the harvests and all the tries. */
  menagement?: Pacing;
  /** Tests only: the base of the DuckDuckGo searches (see OptionsRecolte). */
  urlRecherche?: string;
  /**
   * Workshop startup: no check or harvest before its end (otherwise each launch would show a brief
   * « atelier arrêté » while the container starts).
   */
  pret?: Promise<unknown>;
  /** Bounded wait for a harvest in progress at shutdown (15 s by default). */
  attenteArretMs?: number;
  /**
   * End of a real successful run of a `recolte.notifier` widget that has new items. The text is only their
   * number: nothing of the data. An error from the callback is logged, never propagated.
   */
  notifier?: (n: NotificationWidget) => void;
}

/**
 * Launches the widgets' harvests in the background as long as the browser is open: one at a time in each lane
 * (short, long), and never two at once for the same widget.
 */
export class WidgetsScheduler {
  private readonly o: SchedulerOptions & { horloge: () => Date; intervalleMs: number; recolter: Harvester; recolterEssai: Tryer };
  private minuterie: NodeJS.Timeout | undefined;
  /** One harvest at a time per lane: each harvest chains onto the previous one of its lane. */
  private files: Record<Route, Promise<unknown>> = { courte: Promise.resolve(), longue: Promise.resolve() };
  /** Per widget, the last request (waiting or in progress, all lanes): the next one waits for it. */
  private parWidget = new Map<string, Promise<unknown>>();
  /** Per widget, its long-lane requests (or whose lane is not yet chosen) waiting or in progress. */
  private longues = new Map<string, number>();
  private verification: Promise<string[]> | null = null;
  /** Widgets whose harvest is running right now (their turn has come). */
  private enCoursIds = new Set<string>();
  private arrete = false;
  /** The runs followed live (those that really run, not a check without harvest). */
  private enDirect: DirectWidget[] = [];
  /** AI calls served in turn between the runs; none without AI. */
  private readonly repartiteur: AiDispatcher | null;
  /** Widgets of the queued requests, not yet started (one per request). */
  private attente: string[] = [];
  /** Startup: the workshop ready and the « en-cours » states from before launch reset. Before any run. */
  private demarrage: Promise<void> | null = null;
  /** Widgets found en-cours at startup (interrupted) and reset, not yet relaunched. */
  private interrompus = new Set<string>();

  constructor(o: SchedulerOptions) {
    // `??` rather than a spread: an option explicitly passed as undefined keeps its default value.
    this.o = {
      ...o,
      horloge: o.horloge ?? (() => new Date()),
      intervalleMs: o.intervalleMs ?? MINUTE,
      recolter: o.recolter ?? runHarvest,
      recolterEssai: o.recolterEssai ?? runAttempt,
    };
    this.repartiteur = o.repartiteur ?? (o.ia ? createAiDispatcher(o.ia) : null);
  }

  /** What is running right now, and the requests waiting for their turn. */
  direct(): DirectState {
    // A copy: the caller does not see the tracked state move, and cannot modify it.
    return structuredClone({ courants: this.enDirect, enAttente: [...new Set(this.attente)] });
  }

  /** An error from the callback must never stop a run. */
  private signalerDirect(): void {
    if (!this.o.surDirect) return;
    try {
      this.o.surDirect(this.direct());
    } catch (e) {
      console.error("[webaios] suivi en direct :", e);
    }
  }

  /** A request enters the queue; `commencee` takes it out when its turn comes. */
  private demande(id: string): { commencee(): void } {
    this.attente.push(id);
    this.signalerDirect();
    let done = false;
    return {
      commencee: () => {
        if (done) return;
        done = true;
        const i = this.attente.indexOf(id);
        if (i >= 0) this.attente.splice(i, 1);
        this.signalerDirect();
      },
    };
  }

  /**
   * Follows live the run `f` of widget `widget`. Synchronous: the engine only catches the errors thrown right
   * away by the traces relay. At the end, the blocks are taken from the written run (a block started without an end has
   * no end trace), then nothing is in progress any more.
   */
  private async suivre<T>(
    widget: string,
    kind: DirectWidget["genre"],
    f: (onTrace: (t: DirectTrace) => void, ai: HarvestOptions["ia"]) => Promise<T>,
    runOf: (r: T) => string | undefined,
  ): Promise<T> {
    const tracking: DirectWidget = { widget, genre: kind, debut: this.o.horloge().toISOString(), blocs: {} };
    this.enDirect = [...this.enDirect, tracking];
    this.signalerDirect();
    const onTrace = (t: DirectTrace) => {
      // The `avancement` and `lecture` traces (for the actions) change nothing in a widget's tracking.
      if (!this.enDirect.includes(tracking) || (t.etape !== "debut" && t.etape !== "fin")) return;
      tracking.blocs[t.bloc] = t.etape === "debut" ? { statut: "en-cours", elements: null } : { statut: t.statut, elements: t.elements };
      this.signalerDirect();
    };
    // Each run has its own queue of AI calls.
    const ai = this.repartiteur?.pour(`${widget}:${tracking.debut}`) ?? null;
    let r: T | undefined;
    try {
      r = await f(onTrace, ai);
      return r;
    } finally {
      // Its calls still in the queue no longer go out: they would take the place of the other runs.
      ai?.oublier();
      await this.resynchroniser(tracking, r === undefined ? undefined : runOf(r));
      this.enDirect = this.enDirect.filter((x) => x !== tracking);
      this.signalerDirect();
    }
  }

  private async resynchroniser(tracking: DirectWidget, execution: string | undefined): Promise<void> {
    const e = execution ? await readRun(join(this.o.dossierWidgets, tracking.widget), execution).catch(() => null) : null;
    if (e) {
      const blocks: Record<string, DirectBlock> = {};
      for (const b of e.blocs) {
        if (b.debut === null) continue;
        const status = b.statut === "reussi" || b.statut === "partiel" ? b.statut : "echoue";
        blocks[b.id] = { statut: status, elements: b.elements };
      }
      tracking.blocs = blocks;
    } else {
      // Nothing written (denial, grant withdrawn…): a block still in progress will not finish.
      for (const b of Object.values(tracking.blocs)) if (b.statut === "en-cours") b.statut = "echoue";
    }
    if (this.enDirect.includes(tracking)) this.signalerDirect();
  }

  /** Checks at launch, in the background (a harvest takes time), then at regular intervals. */
  async demarrer(): Promise<void> {
    this.enFond({ auLancement: true });
    this.minuterie = setInterval(() => this.enFond({ auLancement: false }), this.o.intervalleMs);
  }

  /** A background error must never bring the browser down. */
  private enFond(o: { auLancement: boolean }): void {
    this.verifier(o).catch((e) => console.error("[webaios] récolte des widgets :", e));
  }

  /**
   * Launches the due harvests; returns the harvested ids in the short lane. Only one check at a time. It never waits
   * for a watch: a due long harvest is launched without being waited for, and a widget that has a long request
   * waiting or in progress is left for the next check.
   */
  async verifier(o: { auLancement: boolean }): Promise<string[]> {
    if (this.verification || this.arrete) return [];
    this.verification = this.verifierMaintenant(o).finally(() => (this.verification = null));
    return this.verification;
  }

  private async widgets(): Promise<WidgetLu[]> {
    return (await readHome(this.o.chemins, this.o.dossierWidgets)).widgets;
  }

  /** The widget's lane from its declaration read now (short if unknown or unreadable). */
  private async voieActuelle(id: string): Promise<Route> {
    const w = (await this.widgets().catch(() => [])).find((x) => x.id === id);
    return w ? routeOf(w) : "courte";
  }

  /**
   * Runs `f` for widget `id` in the lane of its declaration, read when the widget's turn comes (before entering
   * a lane), then read again under the lane's lock. If it changed while waiting for the lane, the request
   * goes into the other one without losing its turn in the widget.
   */
  private dansSaVoie<T>(id: string, f: (w: WidgetLu | undefined) => Promise<T>): Promise<T> {
    return this.seul(id, "a-choisir", async (route): Promise<T | OtherRoute> => {
      const w = (await this.widgets()).find((x) => x.id === id);
      if (w && routeOf(w) !== route) return new OtherRoute(routeOf(w));
      return f(w);
    });
  }

  /** Every run waits for it: nothing runs before the end of startup. */
  private attendrePret(): Promise<void> {
    this.demarrage ??= Promise.all([this.o.pret?.catch(() => {}), this.remettreInterrompus()]).then(() => {});
    return this.demarrage;
  }

  /**
   * Before any run, nothing is running: an « en-cours » state comes from an interrupted run (abrupt stop). It is
   * reset, whether relaunched or not (no « 7 / 12 » stays frozen): status and error from before the run (`avant`, ok
   * by default; never accord-requis, the run took place after the grant), dates and hour tracking kept, no more
   * progress. The launch check still relaunches it if it is due as an en-cours widget (`du`).
   */
  private async remettreInterrompus(): Promise<void> {
    const { dossierWidgets: widgetsFolder } = this.o;
    const folders = await readdir(widgetsFolder, { withFileTypes: true }).catch(() => []);
    let change = false;
    for (const d of folders) {
      if (!d.isDirectory() || !ID_WIDGET.test(d.name)) continue;
      const restored = await changeWidgetState(widgetsFolder, d.name, (e) => {
        if (e.statut !== "en-cours") return null;
        const before = e.avant && e.avant.statut !== "en-cours" && e.avant.statut !== "accord-requis" ? e.avant : { statut: "ok" as const };
        return { ...before, derniereMaj: e.derniereMaj, derniereTentative: e.derniereTentative, ...(e.heures ? { heures: e.heures } : {}) };
      }).catch((e) => {
        console.error(`[webaios] état du widget ${d.name} :`, e);
        return null;
      });
      if (!restored) continue;
      this.interrompus.add(d.name);
      change = true;
    }
    if (!change) return;
    // A callback that throws must not block startup (all the runs wait for it).
    try {
      this.o.surChange?.();
    } catch (e) {
      console.error("[webaios] remise des états au démarrage :", e);
    }
  }

  /** `widgetDu`, where a widget reset at startup counts, at launch, as still en-cours. */
  private du(w: WidgetLu, o: { auLancement: boolean }): boolean {
    const interrupted = o.auLancement && this.interrompus.has(w.id) && !("erreur" in w) && w.etat.statut !== "accord-requis";
    return widgetOf(interrupted ? { ...w, etat: { ...w.etat, statut: "en-cours" } } : w, this.o.horloge(), o);
  }

  private async verifierMaintenant(o: { auLancement: boolean }): Promise<string[]> {
    await this.attendrePret();
    if (this.arrete) return [];
    await this.enchainer("courte", () => this.oublierWidgetsDisparus());
    // The long ones first: launched without being waited for, they do not stay behind the short ones of this check.
    const due = (await this.widgets())
      .filter((w) => this.du(w, o))
      .sort((a, b) => Number(routeOf(b) === "longue") - Number(routeOf(a) === "longue"));
    if (!due.length) return [];
    const harvests: string[] = [];
    for (const entry of due) {
      if (this.arrete) break;
      const { id } = entry;
      if (this.longues.has(id)) continue;
      const route = routeOf(entry);
      // Read again under the lock: a harvest requested in the meantime may have updated it.
      const tache = this.seul(id, route, async () => {
        const w = (await this.widgets()).find((x) => x.id === id);
        if (!w || !this.du(w, o) || this.arrete) return false;
        // Moved to the other lane since the read: the next check will launch it there.
        if (routeOf(w) !== route) return false;
        if (!(await this.atelierDemarre())) {
          await this.marquerAtelierArrete(w);
          return false;
        }
        if (this.arrete) return false;
        await this.recolter(w, "planifiee");
        return true;
      });
      if (route === "longue") {
        tache.catch((e) => console.error(`[webaios] récolte du widget ${id} :`, e));
        continue;
      }
      if (await tache) harvests.push(id);
    }
    return harvests;
  }

  /**
   * A widget whose folder disappeared loses its grant and its data (state included): recreated later under the same
   * id, it inherits neither the user's consent nor what was read with it. Nothing is erased if the widgets folder
   * itself is missing (unreadable workspace or not yet created).
   */
  private async oublierWidgetsDisparus(): Promise<void> {
    if (!existsSync(this.o.chemins.widgets)) return;
    // A widget that has a request waiting or in progress, in either lane, is left for the next
    // check (a watch, in the other lane, may still write in its folder).
    const presents = new Set([...(await this.widgets()).map((w) => w.id), ...this.parWidget.keys()]);
    const { dossierWidgets: widgetsFolder } = this.o;
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
    if (change) this.o.surChange?.();
  }

  /**
   * Marks `id` as the harvest in progress as soon as its turn comes (before any wait), so that a stop at any
   * moment knows which container to remove.
   */
  private async enCours<T>(id: string, f: () => Promise<T>): Promise<T> {
    this.enCoursIds.add(id);
    try {
      return await f();
    } finally {
      this.enCoursIds.delete(id);
    }
  }

  private enchainer<T>(route: Route, f: () => Promise<T>): Promise<T> {
    const next = this.files[route].catch(() => {}).then(f);
    this.files[route] = next;
    return next;
  }

  private compterLongue(id: string, d: 1 | -1): void {
    const n = (this.longues.get(id) ?? 0) + d;
    if (n > 0) this.longues.set(id, n);
    else this.longues.delete(id);
  }

  /**
   * Runs `f` for widget `id`, after the end of any previous request of this widget, whatever its lane
   * (`dureeMaxMinutes` may have changed while it was running). Its place is taken right away: the order of a
   * widget's requests is kept. The request only enters its lane once the widget is free: it does not hold the other
   * widgets there while waiting. `"a-choisir"`: the lane is read at that moment; if `f` returns `AutreVoie` (changed during
   * the wait for the lane), the request goes into the other one, still at its turn in the widget.
   */
  private seul<T>(id: string, route: Route | "a-choisir", f: (route: Route) => Promise<T | OtherRoute>): Promise<T> {
    // A request whose lane is not yet chosen counts as long: a check does not wait for it.
    let counted = route !== "courte";
    if (counted) this.compterLongue(id, 1);
    const previous = this.parWidget.get(id) ?? Promise.resolve();
    const tache = previous.then(async () => {
      try {
        let v = route === "a-choisir" ? await this.voieActuelle(id) : route;
        for (;;) {
          if (counted !== (v === "longue")) {
            counted = v === "longue";
            this.compterLongue(id, counted ? 1 : -1);
          }
          const planned = v;
          const r = await this.enchainer(planned, () => this.enCours(id, () => f(planned)));
          if (!(r instanceof OtherRoute)) return r;
          v = r.voie;
        }
      } finally {
        if (counted) this.compterLongue(id, -1);
        counted = false;
      }
    });
    const end = tache.catch(() => {});
    this.parWidget.set(id, end);
    void end.then(() => {
      if (this.parWidget.get(id) === end) this.parWidget.delete(id);
    });
    return tache;
  }

  private async atelierDemarre(): Promise<boolean> {
    return (await this.o.atelier.etat().catch(() => "absent")) === "demarre";
  }

  /** Without a workshop, nothing runs: the widget keeps its data and says so (a single write). */
  private async marquerAtelierArrete(w: WidgetLu): Promise<WidgetState> {
    const before = await readWidgetState(this.o.dossierWidgets, w.id);
    if (before.statut === "atelier-arrete") return before;
    const state: WidgetState = {
      statut: "atelier-arrete",
      derniereMaj: before.derniereMaj,
      derniereTentative: before.derniereTentative,
      erreur: WORKSHOP_STOPPED_ERROR,
      erreurNoyau: true,
    };
    await writeWidgetState(this.o.dossierWidgets, w.id, state);
    this.o.surChange?.();
    return state;
  }

  private optionsRecolte(w: WidgetLu, onTrace: (t: DirectTrace) => void, ai: HarvestOptions["ia"]): HarvestOptions {
    return {
      id: w.id,
      widget: w,
      dossierWidgets: this.o.dossierWidgets,
      moteur: this.o.moteur,
      atelier: this.o.atelier,
      ia: ai,
      pont: this.o.pont,
      horloge: this.o.horloge,
      ...(this.o.surChange ? { surChange: this.o.surChange } : {}),
      ...(this.o.adressesLocales ? { adressesLocales: true } : {}),
      ...(this.o.menagement ? { menagement: this.o.menagement } : {}),
      ...(this.o.urlRecherche !== undefined ? { urlRecherche: this.o.urlRecherche } : {}),
      interrompue: () => this.arrete,
      surTrace: onTrace,
    };
  }

  /**
   * A real run. For a widget with hours, its outcome is noted in the tracking, for the slot where it started
   * (tries never go through here).
   */
  private async recolter(w: WidgetLu, trigger: Execution["declencheur"]): Promise<WidgetState & { execution?: string }> {
    const start = this.o.horloge();
    this.interrompus.delete(w.id);
    const { resultat: result, issue: outcome } = await this.executer(w, trigger, start);
    const hours = "erreur" in w ? undefined : w.declaration.recolte?.heures;
    if (!hours) return result;
    const tracking = await this.noterHeure(w.id, currentSlot(hours, start), outcome, this.o.horloge());
    return tracking ? { ...result, heures: tracking } : result;
  }

  /**
   * Writes the hours tracking on the re-read state (nothing before the day's first hour, nor for a run with no effect).
   * `fin`: the end of the run, from which the wait before a retry counts.
   */
  private async noterHeure(id: string, slot: string | null, outcome: HourOutcome, end: Date): Promise<HoursTracking | null> {
    if (!slot || outcome === "sans-effet") return null;
    try {
      const state = await changeWidgetState(this.o.dossierWidgets, id, (e) => ({ ...e, heures: trackingAfter(e.heures, slot, outcome, end.toISOString()) }));
      this.o.surChange?.();
      return state?.heures ?? null;
    } catch (e) {
      console.error(`[webaios] suivi des heures du widget ${id} :`, e);
      return null;
    }
  }

  private async executer(w: WidgetLu, trigger: Execution["declencheur"], start: Date): Promise<{ resultat: WidgetState & { execution?: string }; issue: HourOutcome }> {
    const before = await readWidgetState(this.o.dossierWidgets, w.id);
    let state: WidgetState;
    let execution: string | undefined;
    let fresh: number | undefined;
    try {
      ({ etat: state, execution, nouveaux: fresh } = await this.suivre(
        w.id,
        "execution",
        (onTrace, ai) => this.o.recolter({ ...this.optionsRecolte(w, onTrace, ai), declencheur: trigger }),
        (r) => r.execution,
      ));
    } catch (e) {
      // The harvest may have written en-cours before failing (disk, container…): the widget must not stay there. The exception's
      // text is not kept (it may quote what the widget read): only a fixed kernel message is.
      console.error(`[webaios] récolte du widget ${w.id} :`, e);
      state = this.arrete
        ? before
        : // `derniereTentative` is always the start of the attempt, as in the harvest.
          { statut: "erreur", derniereMaj: before.derniereMaj, derniereTentative: start.toISOString(), erreur: INTERNAL_HARVEST_ERROR, erreurNoyau: true };
      await writeWidgetState(this.o.dossierWidgets, w.id, state);
      this.o.surChange?.();
      return { resultat: state, issue: this.arrete ? "sans-effet" : "echec" };
    }
    // Kernel stop during the harvest (exit, profile change): it did not fail, it will resume later.
    if (this.arrete && state.statut === "erreur") {
      await writeWidgetState(this.o.dossierWidgets, w.id, before);
      this.o.surChange?.();
      return { resultat: { ...before, ...(execution ? { execution } : {}) }, issue: "sans-effet" };
    }
    if (state.statut === "ok" && fresh !== undefined && fresh > 0) this.notifierFin(w, fresh);
    // Grant required, workshop stopped: the run did not really take place.
    const outcome: HourOutcome = state.statut === "ok" ? "reussie" : state.statut === "erreur" ? "echec" : "sans-effet";
    return { resultat: { ...state, ...(execution ? { execution } : {}) }, issue: outcome };
  }

  /** End notification: title = widget name, text = number of new items, never anything from the data. */
  private notifierFin(w: WidgetLu, fresh: number): void {
    if (!this.o.notifier || "erreur" in w || w.declaration.recolte?.notifier !== true) return;
    try {
      // `nom` is written by the agent: control and invisible characters replaced, on a single line.
      const title = w.declaration.nom.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim() || w.id;
      this.o.notifier({ widget: w.id, titre: title, texte: notificationText(fresh) });
    } catch (e) {
      console.error(`[webaios] notification du widget ${w.id} :`, e);
    }
  }

  /**
   * Harvests this widget right away (after the harvest in progress) and returns its new state, with the id of the written run
   * (none if nothing ran: workshop stopped, kernel stopping, grant withdrawn meanwhile).
   */
  async recolterMaintenant(id: string, trigger: Execution["declencheur"] = "manuelle"): Promise<WidgetState & { execution?: string }> {
    const request = this.demande(id);
    await this.attendrePret();
    try {
      return await this.dansSaVoie(id, async (w) => {
        request.commencee();
        if (!w) throw new Error(`Widget inconnu : ${id}`);
        if (this.arrete) return readWidgetState(this.o.dossierWidgets, id);
        if (!(await this.atelierDemarre())) return this.marquerAtelierArrete(w);
        if (this.arrete) return readWidgetState(this.o.dossierWidgets, id);
        return this.recolter(w, trigger);
      });
    } finally {
      request.commencee();
    }
  }

  /**
   * Builder try: replays the widget's workflow from `depart` with the upstream outputs of run
   * `origine`, in the same queue as the real runs (the container carries the widget's id). Without a workshop, refused
   * without touching the widget's state.
   */
  async rejouer(id: string, origin: string, start: string): Promise<AttemptResult> {
    const request = this.demande(id);
    await this.attendrePret();
    // The try follows its widget's lane.
    try {
      return await this.dansSaVoie(id, async (w): Promise<AttemptResult> => {
        request.commencee();
        if (!w) return { ok: false, erreur: `Widget inconnu : ${id}` };
        if (this.arrete) return { ok: false, erreur: INTERRUPTED_ERROR };
        if (!(await this.atelierDemarre())) return { ok: false, erreur: WORKSHOP_STOPPED_ERROR };
        if (this.arrete) return { ok: false, erreur: INTERRUPTED_ERROR };
        try {
          return await this.suivre(
            id,
            "essai",
            (onTrace, ai) => this.o.recolterEssai({ ...this.optionsRecolte(w, onTrace, ai), declencheur: "rejeu", origine: origin, depart: start }),
            (r) => (r.ok ? r.execution : undefined),
          );
        } catch (e) {
          // The exception's text may quote what the widget read: only a fixed kernel message is returned.
          console.error(`[webaios] essai du widget ${id} :`, e);
          return { ok: false, erreur: INTERNAL_HARVEST_ERROR };
        }
      });
    } finally {
      request.commencee();
    }
  }

  private async supprimerConteneurs(): Promise<void> {
    await Promise.all([...this.enCoursIds].map((id) => this.o.atelier.supprimerRecolte(id).catch(() => {})));
  }

  /**
   * Cuts the timer; the harvests in progress (one per lane at most) are killed in their container and waited for, in a
   * bounded way: an interrupted watch must still write its memory and its « interrompue » run.
   */
  async arreter(): Promise<void> {
    clearInterval(this.minuterie);
    this.arrete = true;
    await this.supprimerConteneurs();
    // Bounded: quitting the browser must not wait for a harvest that escaped the shutdown.
    const all = Promise.all([this.files.courte, this.files.longue, ...this.parWidget.values()].map((x) => x.catch(() => {})));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([all, new Promise((ok) => (timer = setTimeout(ok, this.o.attenteArretMs ?? STOP_WAIT_MS)))]);
    clearTimeout(timer);
    // Still not finished: their container may have started after the first removal.
    await this.supprimerConteneurs();
  }
}
