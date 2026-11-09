import type { CheminsEspace } from "../chemins.js";
import type { Atelier } from "../conteneur/atelier.js";
import type { RepartiteurIa } from "../ia/repartiteur.js";
import type { PontNavigateur } from "../mcp/pont.js";
import { ERREUR_ATELIER_ARRETE, ERREUR_INTERROMPUE } from "../widgets/recolte.js";
import type { LanceurProcessus } from "../workflows/executer.js";
import { ACTION_ARRETEE, type Execution } from "../workflows/executions.js";
import type { Menagement } from "../workflows/menagement.js";
import { couperSaisie, executerAction, type OptionsAction, type ResultatLancement, type TraceAction } from "./executer.js";

/** Different actions running at the same time, at most. */
export const ACTIONS_SIMULTANEES = 2;
export const ERREUR_ACTION_INTERNE = "Action impossible : erreur interne du navigateur";
const ATTENTE_ARRET_MS = 15_000;

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
export type EtatActions = { courantes: DirectAction[]; enAttente: { action: string; depuis: string }[] };
/** `deja`: the action was already running (or waiting); `fin` is that of this run. */
export type LancementAction = { deja: boolean; fin: Promise<ResultatLancement> };
export type { ResultatLancement };

export interface OptionsFileActions {
  chemins: CheminsEspace;
  dossierActions: string;
  moteur: string;
  atelier: Pick<Atelier, "etat" | "commandeRecolte" | "supprimerRecolte">;
  lancer?: LanceurProcessus;
  pont: PontNavigateur;
  /** The dispatcher shared with the widgets; null without local AI. */
  repartiteur: Pick<RepartiteurIa, "pour"> | null;
  horloge?: () => Date;
  /** Workshop start: no action leaves before. */
  pret?: Promise<unknown>;
  /** Called on each change of `direct()`; must return control right away. */
  surDirect?: (e: EtatActions) => void;
  adressesLocales?: boolean;
  menagement?: Menagement;
  urlRecherche?: string;
  delaiMiseEnPageMs?: number;
  /** Bounded wait for running actions at shutdown (15 s by default). */
  attenteArretMs?: number;
  /** Tests: replaces the real run of an action. */
  executer?: (o: OptionsAction) => Promise<ResultatLancement>;
}

type Demande = {
  id: string;
  saisie: string | null;
  declencheur: Execution["declencheur"];
  essai: { origine: string; depart: string } | null;
  ctl: AbortController;
  fin: Promise<ResultatLancement>;
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
  private readonly o: OptionsFileActions & { horloge: () => Date; executer: (o: OptionsAction) => Promise<ResultatLancement> };
  /** Per action, its pending or running request. */
  private readonly parAction = new Map<string, Demande>();
  /** Requests that have a slot (they run), in the order they got it. */
  private enCours: Demande[] = [];
  /** Requests waiting for a slot. */
  private attente: Demande[] = [];
  private arrete = false;

  constructor(o: OptionsFileActions) {
    this.o = { ...o, horloge: o.horloge ?? (() => new Date()), executer: o.executer ?? executerAction };
  }

  lancer(id: string, o: { saisie: string | null; declencheur: Execution["declencheur"] }): LancementAction {
    return this.demander(id, { saisie: couperSaisie(o.saisie), declencheur: o.declencheur, essai: null });
  }

  /** Builder trial: replays from `depart` with the upstream outputs of run `origine`. */
  essayer(id: string, origine: string, depart: string): LancementAction {
    return this.demander(id, { saisie: null, declencheur: "rejeu", essai: { origine, depart } });
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

  direct(): EtatActions {
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
    let minuterie: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(fins), new Promise((ok) => (minuterie = setTimeout(ok, this.o.attenteArretMs ?? ATTENTE_ARRET_MS)))]);
    clearTimeout(minuterie);
    // Still not finished: their container may have started after the first deletion.
    await this.supprimerConteneurs();
  }

  private async supprimerConteneurs(): Promise<void> {
    await Promise.all(this.enCours.map((d) => this.o.atelier.supprimerRecolte({ type: "action", id: d.id }).catch(() => {})));
  }

  private demander(id: string, o: Pick<Demande, "saisie" | "declencheur" | "essai">): LancementAction {
    const existante = this.parAction.get(id);
    if (existante) return { deja: true, fin: existante.fin };
    if (this.arrete) return { deja: false, fin: Promise.resolve(this.arretee()) };
    const d: Demande = { id, ...o, ctl: new AbortController(), fin: Promise.resolve(this.arretee()), depuis: this.o.horloge().toISOString() };
    // The request leaves the map before its end is returned: a request made after the end starts again.
    d.fin = this.derouler(d).finally(() => {
      if (this.parAction.get(id) === d) this.parAction.delete(id);
    });
    this.parAction.set(id, d);
    return { deja: false, fin: d.fin };
  }

  /** Stopped before running: nothing is written. */
  private arretee(): ResultatLancement {
    return { statut: "interrompue", erreur: this.arrete ? ERREUR_INTERROMPUE : ACTION_ARRETEE, erreurNoyau: true };
  }

  private async derouler(d: Demande): Promise<ResultatLancement> {
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
      return { statut: "echouee", erreur: ERREUR_ACTION_INTERNE, erreurNoyau: true };
    }
  }

  /** Takes a slot, or waits for its own; false if the request is stopped in the meantime. */
  private place(d: Demande): Promise<boolean> {
    if (this.enCours.length < ACTIONS_SIMULTANEES) {
      this.enCours.push(d);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((ok) => {
      d.depuis = this.o.horloge().toISOString();
      d.placer = (oui) => {
        delete d.placer;
        ok(oui);
      };
      this.attente.push(d);
      this.signalerDirect();
    });
  }

  private liberer(d: Demande): void {
    this.enCours = this.enCours.filter((x) => x !== d);
    const suivante = this.attente.shift();
    if (suivante) {
      this.enCours.push(suivante);
      suivante.placer?.(true);
    }
    this.signalerDirect();
  }

  private async executer(d: Demande): Promise<ResultatLancement> {
    const debut = this.o.horloge().toISOString();
    const suivi: DirectAction = { action: d.id, debut, saisie: d.saisie, essai: d.essai !== null, etape: "workflow", blocs: {} };
    d.direct = suivi;
    this.signalerDirect();
    if ((await this.o.atelier.etat().catch(() => "absent")) !== "demarre") {
      return { statut: "echouee", erreur: ERREUR_ATELIER_ARRETE, erreurNoyau: true };
    }
    const surTrace = (t: TraceAction) => {
      if (d.direct !== suivi) return;
      const b = suivi.blocs[t.bloc];
      if (t.etape === "debut") suivi.blocs[t.bloc] = { statut: "en-cours", elements: null };
      else if (t.etape === "fin") suivi.blocs[t.bloc] = { statut: t.statut, elements: t.elements };
      else if (t.etape === "avancement") suivi.blocs[t.bloc] = { ...(b ?? { statut: "en-cours", elements: null }), faits: t.faits, total: t.total };
      else suivi.blocs[t.bloc] = { ...(b ?? { statut: "en-cours", elements: null }), hote: t.hote };
      if (t.type !== undefined) suivi.blocs[t.bloc]!.type = t.type;
      this.signalerDirect();
    };
    const surEtape = (e: "mise-en-page") => {
      if (d.direct !== suivi) return;
      suivi.etape = e;
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
        surEtape,
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
