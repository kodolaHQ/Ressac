import type { SpacePaths } from "../paths.js";
import type { Atelier } from "../container/workshop.js";
import type { AiDispatcher } from "../ai/dispatcher.js";
import type { BrowserBridge } from "../mcp/pont.js";
import { WORKSHOP_STOPPED_ERROR, INTERRUPTED_ERROR } from "../widgets/harvest.js";
import type { ProcessLauncher } from "../workflows/executer.js";
import { ACTION_STOPPED, type Execution } from "../workflows/executions.js";
import type { Pacing } from "../workflows/pacing.js";
import { cutInput, executerAction, type OptionsAction, type LaunchResult, type TraceAction } from "./executer.js";

/** Different actions running at the same time, at most. */
export const CONCURRENT_ACTIONS = 2;
export const INTERNAL_ACTION_ERROR = "Action impossible : erreur interne du navigateur";
const STOP_WAIT_MS = 15_000;

/** A running action, from its traces: what its page shows during the run. */
export type DirectAction = {
  action: string;
  debut: string;
  saisie: string | null;
  essai: boolean;
  etape: "workflow" | "mise-en-page";
  /** `type`: that of the block in the workflow (its label is the catalog's). */
  blocs: Record<string, { statut: "en-cours" | "reussi" | "partiel" | "echoue"; elements: number | null; faits?: number; total?: number; hote?: string; type?: string }>;
};
export type ActionsState = { courantes: DirectAction[]; enAttente: { action: string; depuis: string }[] };
/** `deja`: the action was already running (or waiting); `fin` is that of this run. */
export type ActionLaunch = { deja: boolean; fin: Promise<LaunchResult> };
export type { LaunchResult };

export interface OptionsFileActions {
  chemins: SpacePaths;
  dossierActions: string;
  moteur: string;
  atelier: Pick<Atelier, "etat" | "commandeRecolte" | "supprimerRecolte">;
  lancer?: ProcessLauncher;
  pont: BrowserBridge;
  /** The dispatcher shared with the widgets; null without local AI. */
  repartiteur: Pick<AiDispatcher, "pour"> | null;
  horloge?: () => Date;
  /** Workshop start: no action leaves before. */
  pret?: Promise<unknown>;
  /** Called on each change of `direct()`; must return control right away. */
  surDirect?: (e: ActionsState) => void;
  adressesLocales?: boolean;
  menagement?: Pacing;
  urlRecherche?: string;
  delaiMiseEnPageMs?: number;
  /** Bounded wait for running actions at shutdown (15 s by default). */
  attenteArretMs?: number;
  /** Tests: replaces the real run of an action. */
  executer?: (o: OptionsAction) => Promise<LaunchResult>;
}

type Request = {
  id: string;
  saisie: string | null;
  declencheur: Execution["declencheur"];
  essai: { origine: string; depart: string } | null;
  ctl: AbortController;
  fin: Promise<LaunchResult>;
  depuis: string;
  /** Present while waiting for a slot: grants it (true) or gives up (false). */
  placer?: (ok: boolean) => void;
  direct?: DirectAction;
};

/**
 * The actions queue, apart from that of widget harvests (an action never waits for a harvest): at most
 * `ACTIONS_SIMULTANEES` different actions at the same time, the next ones wait their turn; only one run at a
 * time per action (a request while it runs or waits returns that one).
 */
export class FileActions {
  private readonly o: OptionsFileActions & { horloge: () => Date; executer: (o: OptionsAction) => Promise<LaunchResult> };
  /** Per action, its pending or running request. */
  private readonly parAction = new Map<string, Request>();
  /** Requests that have a slot (they run), in the order they got it. */
  private enCours: Request[] = [];
  /** Requests waiting for a slot. */
  private attente: Request[] = [];
  private arrete = false;

  constructor(o: OptionsFileActions) {
    this.o = { ...o, horloge: o.horloge ?? (() => new Date()), executer: o.executer ?? executerAction };
  }

  lancer(id: string, o: { saisie: string | null; declencheur: Execution["declencheur"] }): ActionLaunch {
    return this.demander(id, { saisie: cutInput(o.saisie), declencheur: o.declencheur, essai: null });
  }

  /** Builder trial: replays from `depart` with the upstream outputs of run `origine`. */
  essayer(id: string, origin: string, depart: string): ActionLaunch {
    return this.demander(id, { saisie: null, declencheur: "rejeu", essai: { origine: origin, depart } });
  }

  /** Stops this action's run (or removes it from the queue); false if it neither runs nor waits. */
  arreter(id: string): boolean {
    const d = this.parAction.get(id);
    if (!d) return false;
    d.ctl.abort();
    if (d.placer) {
      this.attente = this.attente.filter((x) => x !== d);
      d.placer(false);
      this.signalerDirect();
    }
    return true;
  }

  direct(): ActionsState {
    // A copy: the caller does not see the tracked state move, and cannot modify it.
    return structuredClone({
      courantes: this.enCours.flatMap((d) => (d.direct ? [d.direct] : [])),
      enAttente: this.attente.map((d) => ({ action: d.id, depuis: d.depuis })),
    });
  }

  /**
   * Kernel shutdown: all actions are stopped (those running write an « interrupted » run),
   * their containers deleted, and they are awaited in a bounded way. Nothing leaves afterwards.
   */
  async arreterTout(): Promise<void> {
    this.arrete = true;
    const fins = [...this.parAction.values()].map((d) => d.fin.catch(() => {}));
    for (const id of [...this.parAction.keys()]) this.arreter(id);
    await this.supprimerConteneurs();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(fins), new Promise((ok) => (timer = setTimeout(ok, this.o.attenteArretMs ?? STOP_WAIT_MS)))]);
    clearTimeout(timer);
    // Still not finished: their container may have started after the first deletion.
    await this.supprimerConteneurs();
  }

  private async supprimerConteneurs(): Promise<void> {
    await Promise.all(this.enCours.map((d) => this.o.atelier.supprimerRecolte({ type: "action", id: d.id }).catch(() => {})));
  }

  private demander(id: string, o: Pick<Request, "saisie" | "declencheur" | "essai">): ActionLaunch {
    const existing = this.parAction.get(id);
    if (existing) return { deja: true, fin: existing.fin };
    if (this.arrete) return { deja: false, fin: Promise.resolve(this.arretee()) };
    const d: Request = { id, ...o, ctl: new AbortController(), fin: Promise.resolve(this.arretee()), depuis: this.o.horloge().toISOString() };
    // The request leaves the map before its end is returned: a request made after the end starts again.
    d.fin = this.derouler(d).finally(() => {
      if (this.parAction.get(id) === d) this.parAction.delete(id);
    });
    this.parAction.set(id, d);
    return { deja: false, fin: d.fin };
  }

  /** Stopped before running: nothing is written. */
  private arretee(): LaunchResult {
    return { statut: "interrompue", erreur: this.arrete ? INTERRUPTED_ERROR : ACTION_STOPPED, erreurNoyau: true };
  }

  private async derouler(d: Request): Promise<LaunchResult> {
    try {
      await this.o.pret?.catch(() => {});
      if (this.arrete || d.ctl.signal.aborted) return this.arretee();
      if (!(await this.place(d))) return this.arretee();
      try {
        return await this.executer(d);
      } finally {
        this.liberer(d);
      }
    } catch (e) {
      // The exception text may quote what the action read: only a fixed kernel message is returned.
      console.error(`[webaios] action ${d.id} :`, e);
      return { statut: "echouee", erreur: INTERNAL_ACTION_ERROR, erreurNoyau: true };
    }
  }

  /** Takes a slot, or waits for its own; false if the request is stopped in the meantime. */
  private place(d: Request): Promise<boolean> {
    if (this.enCours.length < CONCURRENT_ACTIONS) {
      this.enCours.push(d);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((ok) => {
      d.depuis = this.o.horloge().toISOString();
      d.placer = (yes) => {
        delete d.placer;
        ok(yes);
      };
      this.attente.push(d);
      this.signalerDirect();
    });
  }

  private liberer(d: Request): void {
    this.enCours = this.enCours.filter((x) => x !== d);
    const next = this.attente.shift();
    if (next) {
      this.enCours.push(next);
      next.placer?.(true);
    }
    this.signalerDirect();
  }

  private async executer(d: Request): Promise<LaunchResult> {
    const debut = this.o.horloge().toISOString();
    const tracking: DirectAction = { action: d.id, debut, saisie: d.saisie, essai: d.essai !== null, etape: "workflow", blocs: {} };
    d.direct = tracking;
    this.signalerDirect();
    if ((await this.o.atelier.etat().catch(() => "absent")) !== "demarre") {
      return { statut: "echouee", erreur: WORKSHOP_STOPPED_ERROR, erreurNoyau: true };
    }
    const surTrace = (t: TraceAction) => {
      if (d.direct !== tracking) return;
      const b = tracking.blocs[t.bloc];
      if (t.etape === "debut") tracking.blocs[t.bloc] = { statut: "en-cours", elements: null };
      else if (t.etape === "fin") tracking.blocs[t.bloc] = { statut: t.statut, elements: t.elements };
      else if (t.etape === "avancement") tracking.blocs[t.bloc] = { ...(b ?? { statut: "en-cours", elements: null }), faits: t.faits, total: t.total };
      else tracking.blocs[t.bloc] = { ...(b ?? { statut: "en-cours", elements: null }), hote: t.hote };
      if (t.type !== undefined) tracking.blocs[t.bloc]!.type = t.type;
      this.signalerDirect();
    };
    const onStep = (e: "mise-en-page") => {
      if (d.direct !== tracking) return;
      tracking.etape = e;
      this.signalerDirect();
    };
    // Each run has its own queue of AI calls, served before those of widgets.
    const ia = this.o.repartiteur?.pour(`action:${d.id}:${debut}`, { prioritaire: true }) ?? null;
    try {
      return await this.o.executer({
        id: d.id,
        chemins: this.o.chemins,
        dossierActions: this.o.dossierActions,
        moteur: this.o.moteur,
        atelier: this.o.atelier,
        ...(this.o.lancer ? { lancer: this.o.lancer } : {}),
        pont: this.o.pont,
        ia,
        horloge: this.o.horloge,
        saisie: d.saisie,
        declencheur: d.declencheur,
        signal: d.ctl.signal,
        surTrace,
        surEtape: onStep,
        ...(d.essai ? { essai: d.essai } : {}),
        interrompue: () => this.arrete,
        ...(this.o.adressesLocales ? { adressesLocales: true } : {}),
        ...(this.o.menagement ? { menagement: this.o.menagement } : {}),
        ...(this.o.urlRecherche !== undefined ? { urlRecherche: this.o.urlRecherche } : {}),
        ...(this.o.delaiMiseEnPageMs !== undefined ? { delaiMiseEnPageMs: this.o.delaiMiseEnPageMs } : {}),
      });
    } finally {
      // Its calls still queued no longer leave: they would take the place of other runs.
      ia?.oublier();
      delete d.direct;
    }
  }

  /** An error from the callback must never stop a run. */
  private signalerDirect(): void {
    if (!this.o.surDirect) return;
    try {
      this.o.surDirect(this.direct());
    } catch (e) {
      console.error("[webaios] suivi des actions :", e);
    }
  }
}
