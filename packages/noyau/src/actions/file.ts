import type { CheminsEspace } from "../chemins.js";
import type { Atelier } from "../conteneur/atelier.js";
import type { RepartiteurIa } from "../ia/repartiteur.js";
import type { PontNavigateur } from "../mcp/pont.js";
import { ERREUR_ATELIER_ARRETE, ERREUR_INTERROMPUE } from "../widgets/recolte.js";
import type { LanceurProcessus } from "../workflows/executer.js";
import { ACTION_ARRETEE, type Execution } from "../workflows/executions.js";
import type { Menagement } from "../workflows/menagement.js";
import { couperSaisie, executerAction, type OptionsAction, type ResultatLancement, type TraceAction } from "./executer.js";

/** Actions différentes qui tournent en même temps, au plus. */
export const ACTIONS_SIMULTANEES = 2;
export const ERREUR_ACTION_INTERNE = "Action impossible : erreur interne du navigateur";
const ATTENTE_ARRET_MS = 15_000;

/** Une action qui tourne, d'après ses traces : ce que sa page montre pendant l'exécution. */
export type DirectAction = {
  action: string;
  debut: string;
  saisie: string | null;
  essai: boolean;
  etape: "workflow" | "mise-en-page";
  /** `type` : celui du bloc dans le workflow (son libellé est celui du catalogue). */
  blocs: Record<string, { statut: "en-cours" | "reussi" | "partiel" | "echoue"; elements: number | null; faits?: number; total?: number; hote?: string; type?: string }>;
};
export type EtatActions = { courantes: DirectAction[]; enAttente: { action: string; depuis: string }[] };
/** `deja` : l'action tournait (ou attendait) déjà ; `fin` est celle de cette exécution-là. */
export type LancementAction = { deja: boolean; fin: Promise<ResultatLancement> };
export type { ResultatLancement };

export interface OptionsFileActions {
  chemins: CheminsEspace;
  dossierActions: string;
  moteur: string;
  atelier: Pick<Atelier, "etat" | "commandeRecolte" | "supprimerRecolte">;
  lancer?: LanceurProcessus;
  pont: PontNavigateur;
  /** Le répartiteur partagé avec les widgets ; null sans IA locale. */
  repartiteur: Pick<RepartiteurIa, "pour"> | null;
  horloge?: () => Date;
  /** Démarrage de l'atelier : aucune action ne part avant. */
  pret?: Promise<unknown>;
  /** Appelé à chaque changement de `direct()` ; doit rendre la main tout de suite. */
  surDirect?: (e: EtatActions) => void;
  adressesLocales?: boolean;
  menagement?: Menagement;
  urlRecherche?: string;
  delaiMiseEnPageMs?: number;
  /** Attente bornée des actions en cours à l'arrêt (15 s par défaut). */
  attenteArretMs?: number;
  /** Tests : remplace l'exécution réelle d'une action. */
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
  /** Présent pendant l'attente d'une place : la donne (true) ou y renonce (false). */
  placer?: (ok: boolean) => void;
  direct?: DirectAction;
};

/**
 * La file des actions, à part de celle des récoltes de widgets (une action n'attend jamais une récolte) : au plus
 * `ACTIONS_SIMULTANEES` actions différentes en même temps, les suivantes attendent leur tour ; une seule exécution à la
 * fois par action (une demande pendant qu'elle tourne ou attend rend celle-là).
 */
export class FileActions {
  private readonly o: OptionsFileActions & { horloge: () => Date; executer: (o: OptionsAction) => Promise<ResultatLancement> };
  /** Par action, sa demande en attente ou en cours. */
  private readonly parAction = new Map<string, Demande>();
  /** Les demandes qui ont une place (elles tournent), dans l'ordre où elles l'ont eue. */
  private enCours: Demande[] = [];
  /** Les demandes qui attendent une place. */
  private attente: Demande[] = [];
  private arrete = false;

  constructor(o: OptionsFileActions) {
    this.o = { ...o, horloge: o.horloge ?? (() => new Date()), executer: o.executer ?? executerAction };
  }

  lancer(id: string, o: { saisie: string | null; declencheur: Execution["declencheur"] }): LancementAction {
    return this.demander(id, { saisie: couperSaisie(o.saisie), declencheur: o.declencheur, essai: null });
  }

  /** Essai du constructeur : rejoue depuis `depart` avec les sorties amont de l'exécution `origine`. */
  essayer(id: string, origine: string, depart: string): LancementAction {
    return this.demander(id, { saisie: null, declencheur: "rejeu", essai: { origine, depart } });
  }

  /** Arrête l'exécution de cette action (ou la retire de la file) ; faux si elle ne tourne ni n'attend. */
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
    // Une copie : l'appelant ne voit pas bouger l'état suivi, et ne peut pas le modifier.
    return structuredClone({
      courantes: this.enCours.flatMap((d) => (d.direct ? [d.direct] : [])),
      enAttente: this.attente.map((d) => ({ action: d.id, depuis: d.depuis })),
    });
  }

  /**
   * Arrêt du noyau : toutes les actions sont arrêtées (celles qui tournent écrivent une exécution « interrompue »),
   * leurs conteneurs supprimés, et elles sont attendues de façon bornée. Plus rien ne part ensuite.
   */
  async arreterTout(): Promise<void> {
    this.arrete = true;
    const fins = [...this.parAction.values()].map((d) => d.fin.catch(() => {}));
    for (const id of [...this.parAction.keys()]) this.arreter(id);
    await this.supprimerConteneurs();
    let minuterie: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(fins), new Promise((ok) => (minuterie = setTimeout(ok, this.o.attenteArretMs ?? ATTENTE_ARRET_MS)))]);
    clearTimeout(minuterie);
    // Toujours pas finies : leur conteneur a pu démarrer après la première suppression.
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
    // La demande quitte la carte avant que sa fin soit rendue : une demande faite après la fin repart.
    d.fin = this.derouler(d).finally(() => {
      if (this.parAction.get(id) === d) this.parAction.delete(id);
    });
    this.parAction.set(id, d);
    return { deja: false, fin: d.fin };
  }

  /** Arrêtée avant d'avoir tourné : rien n'est écrit. */
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
      // Le texte de l'exception peut citer ce que l'action a lu : seul un message fixe du noyau est rendu.
      console.error(`[webaios] action ${d.id} :`, e);
      return { statut: "echouee", erreur: ERREUR_ACTION_INTERNE, erreurNoyau: true };
    }
  }

  /** Prend une place, ou attend la sienne ; faux si la demande est arrêtée entre-temps. */
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
    // Chaque exécution a sa file d'appels à l'IA, servie avant celles des widgets.
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
      // Ses appels encore en file ne partent plus : ils prendraient la place des autres exécutions.
      ia?.oublier();
      delete d.direct;
    }
  }

  /** Une erreur du rappel ne doit jamais arrêter une exécution. */
  private signalerDirect(): void {
    if (!this.o.surDirect) return;
    try {
      this.o.surDirect(this.direct());
    } catch (e) {
      console.error("[webaios] suivi des actions :", e);
    }
  }
}
