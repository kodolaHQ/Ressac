import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CheminsEspace } from "../chemins.js";
import { ecrireEtatWidget, lireEtatWidget, modifierEtatWidget } from "../accueil/donnees.js";
import { lireAccueil } from "../accueil/lire.js";
import type { EtatWidget, WidgetLu } from "../accueil/schemas.js";
import type { Atelier } from "../conteneur/atelier.js";
import type { IaLocale } from "../ia/ia-locale.js";
import { creerRepartiteurIa } from "../ia/repartiteur.js";
import type { PontNavigateur } from "../mcp/pont.js";
import { lireAccords, retirerAccord } from "./accords.js";
import { creneauCourant, heureDue, suiviApres, type IssueHeure, type SuiviHeures } from "./heures.js";
import type { TraceDirecte } from "../workflows/executer.js";
import { lireExecution, type Execution } from "../workflows/executions.js";
import type { Menagement } from "../workflows/menagement.js";
import { texteNotification, type NotificationWidget } from "./nouveautes.js";
import {
  ERREUR_ATELIER_ARRETE,
  ERREUR_INTERROMPUE,
  ERREUR_RECOLTE_INTERNE,
  executerEssai,
  executerRecolte,
  type OptionsRecolte,
  type ResultatEssai,
  type ResultatRecolte,
} from "./recolte.js";

export { ERREUR_ATELIER_ARRETE, ERREUR_RECOLTE_INTERNE, type ResultatEssai };

/** Un bloc de l'exécution en cours, d'après ses traces. */
export type BlocDirect = { statut: "en-cours" | "reussi" | "partiel" | "echoue"; elements: number | null };
/** Une exécution (vraie, ou essai du constructeur) qui tourne en ce moment. */
export type DirectWidget = { widget: string; genre: "execution" | "essai"; debut: string; blocs: Record<string, BlocDirect> };
/**
 * `courants` : les exécutions qui tournent (une par voie au plus, dans l'ordre où elles ont commencé). `enAttente` :
 * widgets dont une demande (récolte manuelle, essai) attend son tour.
 */
export type EtatDirect = { courants: DirectWidget[]; enAttente: string[] };

/** Au-delà de cette durée maximale (en minutes), un widget tourne dans la voie longue. */
export const VOIE_LONGUE_MINUTES = 3;
export type Voie = "courte" | "longue";

/**
 * Les veilles (`dureeMaxMinutes` > 3) ont leur propre voie : une à la fois dans l'application, sans retenir les widgets
 * courts, qui gardent la leur.
 */
export function voieDe(w: WidgetLu): Voie {
  if ("erreur" in w) return "courte";
  return (w.declaration.recolte?.dureeMaxMinutes ?? 0) > VOIE_LONGUE_MINUTES ? "longue" : "courte";
}

/** Rendu par une demande dont le widget a changé de voie pendant qu'elle attendait. */
class AutreVoie {
  constructor(readonly voie: Voie) {}
}

const MINUTE = 60_000;
/** Une récolte en erreur est retentée au plus tôt 15 min après sa dernière tentative. */
const REESSAI_ERREUR_MS = 15 * MINUTE;
const ATTENTE_ARRET_MS = 15_000;
const ID_WIDGET = /^[a-z0-9-]+$/;

const age = (iso: string | null, maintenant: Date) => (iso ? maintenant.getTime() - Date.parse(iso) : Infinity);

/**
 * Le widget est-il à récolter maintenant ? Il faut une récolte (déclarée, et `workflow.json` ou `recolte.mjs` présent), un statut autre
 * qu'`accord-requis` (seul l'utilisateur débloque), et soit des données plus vieilles que `recolte.minutes` (ou absentes), soit
 * une heure fixe à faire (`heureDue`). Après une erreur, la fréquence attend en plus 15 min depuis la dernière
 * tentative. `en-cours` n'est relancé qu'au lancement (la récolte précédente a été interrompue), et seulement s'il a une
 * fréquence ou une heure à faire : sinon, c'est la nôtre qui tourne.
 */
export function widgetDu(w: WidgetLu, maintenant: Date, o: { auLancement: boolean }): boolean {
  if ("erreur" in w || !w.aRecolte || !w.declaration.recolte) return false;
  const { minutes, heures } = w.declaration.recolte;
  const { statut, derniereMaj, derniereTentative } = w.etat;
  if (statut === "accord-requis") return false;
  const parHeure = heures !== undefined && heureDue(heures, w.etat.heures, derniereTentative, maintenant);
  if (statut === "en-cours") return o.auLancement && (minutes !== undefined || parHeure);
  if (parHeure) return true;
  if (minutes === undefined) return false; // heures fixes seules : jamais dû par la fréquence
  if (age(derniereMaj, maintenant) < minutes * MINUTE) return false;
  return statut !== "erreur" || age(derniereTentative, maintenant) >= REESSAI_ERREUR_MS;
}

export type Recolteuse = (o: OptionsRecolte) => Promise<ResultatRecolte>;
export type Essayeuse = (o: OptionsRecolte & { origine: string; depart: string }) => Promise<ResultatEssai>;

export interface OptionsPlanificateur {
  chemins: CheminsEspace;
  dossierWidgets: string;
  /** Dossier du moteur des workflows (`docker/moteur`), monté en lecture seule dans le conteneur. */
  moteur: string;
  atelier: Pick<Atelier, "etat" | "commandeRecolte" | "supprimerRecolte">;
  pont: PontNavigateur;
  ia: Pick<IaLocale, "kev" | "gemma"> | null;
  horloge?: () => Date;
  /** Vérification des récoltes dues (par défaut chaque minute). */
  intervalleMs?: number;
  /** Appelé après chaque écriture de l'état ou des données d'un widget. */
  surChange?: () => void;
  /** Tests : remplace l'exécution réelle de la récolte. */
  recolter?: Recolteuse;
  /** Tests : remplace l'exécution réelle d'un essai. */
  recolterEssai?: Essayeuse;
  /** Appelé à chaque entrée et sortie de la file, et à chaque trace de l'exécution en cours. */
  surDirect?: (e: EtatDirect) => void;
  /** Tests seulement : les récoltes peuvent lire des adresses locales (voir OptionsRecolte). */
  adressesLocales?: boolean;
  /** Ménagement des recherches et des lectures ouvertes, partagé par toutes les récoltes et tous les essais. */
  menagement?: Menagement;
  /** Tests seulement : la base des recherches DuckDuckGo (voir OptionsRecolte). */
  urlRecherche?: string;
  /**
   * Démarrage de l'atelier : aucune vérification ni récolte avant sa fin (sinon chaque lancement afficherait un bref
   * « atelier arrêté » pendant que le conteneur démarre).
   */
  pret?: Promise<unknown>;
  /** Attente bornée d'une récolte en cours à l'arrêt (15 s par défaut). */
  attenteArretMs?: number;
  /**
   * Fin d'une vraie exécution réussie d'un widget `recolte.notifier` qui a de nouveaux éléments. Le texte n'est que leur
   * nombre : rien des données. Une erreur du rappel est journalisée, jamais propagée.
   */
  notifier?: (n: NotificationWidget) => void;
}

/**
 * Lance les récoltes des widgets en arrière-plan tant que le navigateur est ouvert : une à la fois dans chaque voie
 * (courte, longue), et jamais deux à la fois pour un même widget.
 */
export class PlanificateurWidgets {
  private readonly o: OptionsPlanificateur & { horloge: () => Date; intervalleMs: number; recolter: Recolteuse; recolterEssai: Essayeuse };
  private minuterie: NodeJS.Timeout | undefined;
  /** Une récolte à la fois par voie : chaque récolte s'enchaîne sur la précédente de sa voie. */
  private files: Record<Voie, Promise<unknown>> = { courte: Promise.resolve(), longue: Promise.resolve() };
  /** Par widget, la dernière demande (en attente ou en cours, toutes voies) : la suivante l'attend. */
  private parWidget = new Map<string, Promise<unknown>>();
  /** Par widget, ses demandes de la voie longue (ou dont la voie n'est pas encore choisie) en attente ou en cours. */
  private longues = new Map<string, number>();
  private verification: Promise<string[]> | null = null;
  /** Widgets dont la récolte tourne en ce moment (leur tour venu). */
  private enCoursIds = new Set<string>();
  private arrete = false;
  /** Les exécutions suivies en direct (celles qui tournent vraiment, pas une vérification sans récolte). */
  private enDirect: DirectWidget[] = [];
  /** Appels à l'IA servis à tour de rôle entre les exécutions ; aucun sans IA. */
  private readonly repartiteur: ReturnType<typeof creerRepartiteurIa> | null;
  /** Widgets des demandes en file, pas encore commencées (un par demande). */
  private attente: string[] = [];
  /** Démarrage : l'atelier prêt et les états « en-cours » d'avant le lancement remis. Avant toute exécution. */
  private demarrage: Promise<void> | null = null;
  /** Widgets trouvés en-cours au démarrage (interrompus) et remis, pas encore relancés. */
  private interrompus = new Set<string>();

  constructor(o: OptionsPlanificateur) {
    // `??` plutôt qu'un spread : une option passée explicitement à undefined garde sa valeur par défaut.
    this.o = {
      ...o,
      horloge: o.horloge ?? (() => new Date()),
      intervalleMs: o.intervalleMs ?? MINUTE,
      recolter: o.recolter ?? executerRecolte,
      recolterEssai: o.recolterEssai ?? executerEssai,
    };
    this.repartiteur = o.ia ? creerRepartiteurIa(o.ia) : null;
  }

  /** Ce qui tourne en ce moment, et les demandes qui attendent leur tour. */
  direct(): EtatDirect {
    // Une copie : l'appelant ne voit pas bouger l'état suivi, et ne peut pas le modifier.
    return structuredClone({ courants: this.enDirect, enAttente: [...new Set(this.attente)] });
  }

  /** Une erreur du rappel ne doit jamais arrêter une exécution. */
  private signalerDirect(): void {
    if (!this.o.surDirect) return;
    try {
      this.o.surDirect(this.direct());
    } catch (e) {
      console.error("[webaios] suivi en direct :", e);
    }
  }

  /** Une demande entre dans la file ; `commencee` l'en sort quand son tour vient. */
  private demande(id: string): { commencee(): void } {
    this.attente.push(id);
    this.signalerDirect();
    let faite = false;
    return {
      commencee: () => {
        if (faite) return;
        faite = true;
        const i = this.attente.indexOf(id);
        if (i >= 0) this.attente.splice(i, 1);
        this.signalerDirect();
      },
    };
  }

  /**
   * Suit en direct l'exécution `f` du widget `widget`. Synchrone : le moteur n'attrape que les erreurs levées tout de
   * suite par le relais des traces. À la fin, les blocs sont repris de l'exécution écrite (un bloc commencé sans fin n'a
   * pas de trace de fin), puis plus rien n'est en cours.
   */
  private async suivre<T>(
    widget: string,
    genre: DirectWidget["genre"],
    f: (surTrace: (t: TraceDirecte) => void, ia: OptionsRecolte["ia"]) => Promise<T>,
    executionDe: (r: T) => string | undefined,
  ): Promise<T> {
    const suivi: DirectWidget = { widget, genre, debut: this.o.horloge().toISOString(), blocs: {} };
    this.enDirect = [...this.enDirect, suivi];
    this.signalerDirect();
    const surTrace = (t: TraceDirecte) => {
      if (!this.enDirect.includes(suivi)) return;
      suivi.blocs[t.bloc] = t.etape === "debut" ? { statut: "en-cours", elements: null } : { statut: t.statut, elements: t.elements };
      this.signalerDirect();
    };
    // Chaque exécution a sa file d'appels à l'IA.
    const ia = this.repartiteur?.pour(`${widget}:${suivi.debut}`) ?? null;
    let r: T | undefined;
    try {
      r = await f(surTrace, ia);
      return r;
    } finally {
      // Ses appels encore en file ne partent plus : ils prendraient la place des autres exécutions.
      ia?.oublier();
      await this.resynchroniser(suivi, r === undefined ? undefined : executionDe(r));
      this.enDirect = this.enDirect.filter((x) => x !== suivi);
      this.signalerDirect();
    }
  }

  private async resynchroniser(suivi: DirectWidget, execution: string | undefined): Promise<void> {
    const e = execution ? await lireExecution(join(this.o.dossierWidgets, suivi.widget), execution).catch(() => null) : null;
    if (e) {
      const blocs: Record<string, BlocDirect> = {};
      for (const b of e.blocs) {
        if (b.debut === null) continue;
        const statut = b.statut === "reussi" || b.statut === "partiel" ? b.statut : "echoue";
        blocs[b.id] = { statut, elements: b.elements };
      }
      suivi.blocs = blocs;
    } else {
      // Rien d'écrit (refus, accord retiré…) : un bloc encore en cours ne finira pas.
      for (const b of Object.values(suivi.blocs)) if (b.statut === "en-cours") b.statut = "echoue";
    }
    if (this.enDirect.includes(suivi)) this.signalerDirect();
  }

  /** Vérifie au lancement, en arrière-plan (une récolte prend du temps), puis à intervalle régulier. */
  async demarrer(): Promise<void> {
    this.enFond({ auLancement: true });
    this.minuterie = setInterval(() => this.enFond({ auLancement: false }), this.o.intervalleMs);
  }

  /** Une erreur de fond ne doit jamais faire tomber le navigateur. */
  private enFond(o: { auLancement: boolean }): void {
    this.verifier(o).catch((e) => console.error("[webaios] récolte des widgets :", e));
  }

  /**
   * Lance les récoltes dues ; rend les ids récoltés dans la voie courte. Une seule vérification à la fois. Elle n'attend
   * jamais une veille : une récolte longue due est lancée sans être attendue, et un widget qui a une demande longue en
   * attente ou en cours est laissé pour la vérification suivante.
   */
  async verifier(o: { auLancement: boolean }): Promise<string[]> {
    if (this.verification || this.arrete) return [];
    this.verification = this.verifierMaintenant(o).finally(() => (this.verification = null));
    return this.verification;
  }

  private async widgets(): Promise<WidgetLu[]> {
    return (await lireAccueil(this.o.chemins, this.o.dossierWidgets)).widgets;
  }

  /** La voie du widget d'après sa déclaration lue maintenant (courte s'il est inconnu ou illisible). */
  private async voieActuelle(id: string): Promise<Voie> {
    const w = (await this.widgets().catch(() => [])).find((x) => x.id === id);
    return w ? voieDe(w) : "courte";
  }

  /**
   * Exécute `f` pour le widget `id` dans la voie de sa déclaration, lue quand le tour du widget vient (avant d'entrer
   * dans une voie), puis relue sous le verrou de la voie. Si elle a changé pendant l'attente de la voie, la demande
   * repart dans l'autre sans perdre son tour dans le widget.
   */
  private dansSaVoie<T>(id: string, f: (w: WidgetLu | undefined) => Promise<T>): Promise<T> {
    return this.seul(id, "a-choisir", async (voie): Promise<T | AutreVoie> => {
      const w = (await this.widgets()).find((x) => x.id === id);
      if (w && voieDe(w) !== voie) return new AutreVoie(voieDe(w));
      return f(w);
    });
  }

  /** Toute exécution l'attend : rien ne tourne avant la fin du démarrage. */
  private attendrePret(): Promise<void> {
    this.demarrage ??= Promise.all([this.o.pret?.catch(() => {}), this.remettreInterrompus()]).then(() => {});
    return this.demarrage;
  }

  /**
   * Avant toute exécution, rien ne tourne : un état « en-cours » vient d'une exécution interrompue (arrêt brutal). Il est
   * remis, qu'il soit relancé ou non (aucun « 7 / 12 » ne reste figé) : statut et erreur d'avant l'exécution (`avant`, ok
   * à défaut ; jamais accord-requis, l'exécution a eu lieu après l'accord), dates et suivi des heures gardés, plus de
   * progression. La vérification du lancement le relance encore s'il est dû comme un widget en-cours (`du`).
   */
  private async remettreInterrompus(): Promise<void> {
    const { dossierWidgets } = this.o;
    const dossiers = await readdir(dossierWidgets, { withFileTypes: true }).catch(() => []);
    let change = false;
    for (const d of dossiers) {
      if (!d.isDirectory() || !ID_WIDGET.test(d.name)) continue;
      const remis = await modifierEtatWidget(dossierWidgets, d.name, (e) => {
        if (e.statut !== "en-cours") return null;
        const avant = e.avant && e.avant.statut !== "en-cours" && e.avant.statut !== "accord-requis" ? e.avant : { statut: "ok" as const };
        return { ...avant, derniereMaj: e.derniereMaj, derniereTentative: e.derniereTentative, ...(e.heures ? { heures: e.heures } : {}) };
      }).catch((e) => {
        console.error(`[webaios] état du widget ${d.name} :`, e);
        return null;
      });
      if (!remis) continue;
      this.interrompus.add(d.name);
      change = true;
    }
    if (!change) return;
    // Un rappel qui lève ne doit pas bloquer le démarrage (toutes les exécutions l'attendent).
    try {
      this.o.surChange?.();
    } catch (e) {
      console.error("[webaios] remise des états au démarrage :", e);
    }
  }

  /** `widgetDu`, où un widget remis au démarrage compte, au lancement, comme encore en-cours. */
  private du(w: WidgetLu, o: { auLancement: boolean }): boolean {
    const interrompu = o.auLancement && this.interrompus.has(w.id) && !("erreur" in w) && w.etat.statut !== "accord-requis";
    return widgetDu(interrompu ? { ...w, etat: { ...w.etat, statut: "en-cours" } } : w, this.o.horloge(), o);
  }

  private async verifierMaintenant(o: { auLancement: boolean }): Promise<string[]> {
    await this.attendrePret();
    if (this.arrete) return [];
    await this.enchainer("courte", () => this.oublierWidgetsDisparus());
    // Les longues d'abord : lancées sans être attendues, elles ne restent pas derrière les courtes de cette vérification.
    const dus = (await this.widgets())
      .filter((w) => this.du(w, o))
      .sort((a, b) => Number(voieDe(b) === "longue") - Number(voieDe(a) === "longue"));
    if (!dus.length) return [];
    const recoltes: string[] = [];
    for (const du of dus) {
      if (this.arrete) break;
      const { id } = du;
      if (this.longues.has(id)) continue;
      const voie = voieDe(du);
      // Relu sous le verrou : une récolte demandée entre-temps a pu le mettre à jour.
      const tache = this.seul(id, voie, async () => {
        const w = (await this.widgets()).find((x) => x.id === id);
        if (!w || !this.du(w, o) || this.arrete) return false;
        // Passé dans l'autre voie depuis la lecture : la vérification suivante l'y lancera.
        if (voieDe(w) !== voie) return false;
        if (!(await this.atelierDemarre())) {
          await this.marquerAtelierArrete(w);
          return false;
        }
        if (this.arrete) return false;
        await this.recolter(w, "planifiee");
        return true;
      });
      if (voie === "longue") {
        tache.catch((e) => console.error(`[webaios] récolte du widget ${id} :`, e));
        continue;
      }
      if (await tache) recoltes.push(id);
    }
    return recoltes;
  }

  /**
   * Un widget dont le dossier a disparu perd son accord et ses données (état compris) : recréé plus tard sous le même
   * id, il n'hérite ni du consentement de l'utilisateur ni de ce qui a été lu avec. Rien n'est effacé si le dossier des widgets
   * lui-même manque (espace illisible ou pas encore créé).
   */
  private async oublierWidgetsDisparus(): Promise<void> {
    if (!existsSync(this.o.chemins.widgets)) return;
    // Un widget qui a une demande en attente ou en cours, dans l'une ou l'autre voie, est laissé à la vérification
    // suivante (une veille, dans l'autre voie, peut encore écrire dans son dossier).
    const presents = new Set([...(await this.widgets()).map((w) => w.id), ...this.parWidget.keys()]);
    const { dossierWidgets } = this.o;
    let change = false;
    for (const id of Object.keys(await lireAccords(dossierWidgets))) {
      if (presents.has(id)) continue;
      await retirerAccord(dossierWidgets, id);
      change = true;
    }
    const dossiers = await readdir(dossierWidgets, { withFileTypes: true }).catch(() => []);
    for (const d of dossiers) {
      if (!d.isDirectory() || !ID_WIDGET.test(d.name) || presents.has(d.name)) continue;
      await rm(join(dossierWidgets, d.name), { recursive: true, force: true });
      change = true;
    }
    if (change) this.o.surChange?.();
  }

  /**
   * Marque `id` comme la récolte en cours dès son tour venu (avant toute attente), pour qu'un arrêt à n'importe quel
   * moment sache quel conteneur supprimer.
   */
  private async enCours<T>(id: string, f: () => Promise<T>): Promise<T> {
    this.enCoursIds.add(id);
    try {
      return await f();
    } finally {
      this.enCoursIds.delete(id);
    }
  }

  private enchainer<T>(voie: Voie, f: () => Promise<T>): Promise<T> {
    const suivante = this.files[voie].catch(() => {}).then(f);
    this.files[voie] = suivante;
    return suivante;
  }

  private compterLongue(id: string, d: 1 | -1): void {
    const n = (this.longues.get(id) ?? 0) + d;
    if (n > 0) this.longues.set(id, n);
    else this.longues.delete(id);
  }

  /**
   * Exécute `f` pour le widget `id`, après la fin de toute demande précédente de ce widget, quelle qu'en soit la voie
   * (`dureeMaxMinutes` a pu changer pendant qu'il tournait). Sa place est prise tout de suite : l'ordre des demandes
   * d'un widget est gardé. La demande n'entre dans sa voie qu'une fois le widget libre : elle n'y retient pas les autres
   * widgets en attendant. `"a-choisir"` : la voie est lue à ce moment-là ; si `f` rend `AutreVoie` (changée pendant
   * l'attente de la voie), la demande repart dans l'autre, toujours à son tour dans le widget.
   */
  private seul<T>(id: string, voie: Voie | "a-choisir", f: (voie: Voie) => Promise<T | AutreVoie>): Promise<T> {
    // Une demande dont la voie n'est pas encore choisie compte comme longue : une vérification ne l'attend pas.
    let comptee = voie !== "courte";
    if (comptee) this.compterLongue(id, 1);
    const precedente = this.parWidget.get(id) ?? Promise.resolve();
    const tache = precedente.then(async () => {
      try {
        let v = voie === "a-choisir" ? await this.voieActuelle(id) : voie;
        for (;;) {
          if (comptee !== (v === "longue")) {
            comptee = v === "longue";
            this.compterLongue(id, comptee ? 1 : -1);
          }
          const prevue = v;
          const r = await this.enchainer(prevue, () => this.enCours(id, () => f(prevue)));
          if (!(r instanceof AutreVoie)) return r;
          v = r.voie;
        }
      } finally {
        if (comptee) this.compterLongue(id, -1);
        comptee = false;
      }
    });
    const fin = tache.catch(() => {});
    this.parWidget.set(id, fin);
    void fin.then(() => {
      if (this.parWidget.get(id) === fin) this.parWidget.delete(id);
    });
    return tache;
  }

  private async atelierDemarre(): Promise<boolean> {
    return (await this.o.atelier.etat().catch(() => "absent")) === "demarre";
  }

  /** Sans atelier, rien ne tourne : le widget garde ses données et l'indique (une seule écriture). */
  private async marquerAtelierArrete(w: WidgetLu): Promise<EtatWidget> {
    const avant = await lireEtatWidget(this.o.dossierWidgets, w.id);
    if (avant.statut === "atelier-arrete") return avant;
    const etat: EtatWidget = {
      statut: "atelier-arrete",
      derniereMaj: avant.derniereMaj,
      derniereTentative: avant.derniereTentative,
      erreur: ERREUR_ATELIER_ARRETE,
      erreurNoyau: true,
    };
    await ecrireEtatWidget(this.o.dossierWidgets, w.id, etat);
    this.o.surChange?.();
    return etat;
  }

  private optionsRecolte(w: WidgetLu, surTrace: (t: TraceDirecte) => void, ia: OptionsRecolte["ia"]): OptionsRecolte {
    return {
      id: w.id,
      widget: w,
      dossierWidgets: this.o.dossierWidgets,
      moteur: this.o.moteur,
      atelier: this.o.atelier,
      ia,
      pont: this.o.pont,
      horloge: this.o.horloge,
      ...(this.o.surChange ? { surChange: this.o.surChange } : {}),
      ...(this.o.adressesLocales ? { adressesLocales: true } : {}),
      ...(this.o.menagement ? { menagement: this.o.menagement } : {}),
      ...(this.o.urlRecherche !== undefined ? { urlRecherche: this.o.urlRecherche } : {}),
      interrompue: () => this.arrete,
      surTrace,
    };
  }

  /**
   * Une vraie exécution. Pour un widget à heures, son issue est notée dans le suivi, pour le créneau où elle a commencé
   * (les essais ne passent jamais par ici).
   */
  private async recolter(w: WidgetLu, declencheur: Execution["declencheur"]): Promise<EtatWidget & { execution?: string }> {
    const debut = this.o.horloge();
    this.interrompus.delete(w.id);
    const { resultat, issue } = await this.executer(w, declencheur, debut);
    const heures = "erreur" in w ? undefined : w.declaration.recolte?.heures;
    if (!heures) return resultat;
    const suivi = await this.noterHeure(w.id, creneauCourant(heures, debut), issue, this.o.horloge());
    return suivi ? { ...resultat, heures: suivi } : resultat;
  }

  /**
   * Écrit le suivi des heures sur l'état relu (rien avant la première heure du jour, ni pour une exécution sans effet).
   * `fin` : la fin de l'exécution, d'où compte l'attente avant un réessai.
   */
  private async noterHeure(id: string, creneau: string | null, issue: IssueHeure, fin: Date): Promise<SuiviHeures | null> {
    if (!creneau || issue === "sans-effet") return null;
    try {
      const etat = await modifierEtatWidget(this.o.dossierWidgets, id, (e) => ({ ...e, heures: suiviApres(e.heures, creneau, issue, fin.toISOString()) }));
      this.o.surChange?.();
      return etat?.heures ?? null;
    } catch (e) {
      console.error(`[webaios] suivi des heures du widget ${id} :`, e);
      return null;
    }
  }

  private async executer(w: WidgetLu, declencheur: Execution["declencheur"], debut: Date): Promise<{ resultat: EtatWidget & { execution?: string }; issue: IssueHeure }> {
    const avant = await lireEtatWidget(this.o.dossierWidgets, w.id);
    let etat: EtatWidget;
    let execution: string | undefined;
    let nouveaux: number | undefined;
    try {
      ({ etat, execution, nouveaux } = await this.suivre(
        w.id,
        "execution",
        (surTrace, ia) => this.o.recolter({ ...this.optionsRecolte(w, surTrace, ia), declencheur }),
        (r) => r.execution,
      ));
    } catch (e) {
      // La récolte a pu écrire en-cours avant d'échouer (disque, conteneur…) : le widget ne doit pas y rester. Le texte
      // de l'exception n'est pas gardé (il peut citer ce que le widget a lu) : seul un message fixe du noyau l'est.
      console.error(`[webaios] récolte du widget ${w.id} :`, e);
      etat = this.arrete
        ? avant
        : // `derniereTentative` est toujours le début de la tentative, comme dans la récolte.
          { statut: "erreur", derniereMaj: avant.derniereMaj, derniereTentative: debut.toISOString(), erreur: ERREUR_RECOLTE_INTERNE, erreurNoyau: true };
      await ecrireEtatWidget(this.o.dossierWidgets, w.id, etat);
      this.o.surChange?.();
      return { resultat: etat, issue: this.arrete ? "sans-effet" : "echec" };
    }
    // Arrêt du noyau pendant la récolte (sortie, changement de profil) : elle n'a pas échoué, elle reprendra plus tard.
    if (this.arrete && etat.statut === "erreur") {
      await ecrireEtatWidget(this.o.dossierWidgets, w.id, avant);
      this.o.surChange?.();
      return { resultat: { ...avant, ...(execution ? { execution } : {}) }, issue: "sans-effet" };
    }
    if (etat.statut === "ok" && nouveaux !== undefined && nouveaux > 0) this.notifierFin(w, nouveaux);
    // Accord requis, atelier arrêté : l'exécution n'a pas vraiment eu lieu.
    const issue: IssueHeure = etat.statut === "ok" ? "reussie" : etat.statut === "erreur" ? "echec" : "sans-effet";
    return { resultat: { ...etat, ...(execution ? { execution } : {}) }, issue };
  }

  /** Notification de fin : titre = nom du widget, texte = nombre de nouveaux éléments, jamais rien des données. */
  private notifierFin(w: WidgetLu, nouveaux: number): void {
    if (!this.o.notifier || "erreur" in w || w.declaration.recolte?.notifier !== true) return;
    try {
      this.o.notifier({ widget: w.id, titre: w.declaration.nom, texte: texteNotification(nouveaux) });
    } catch (e) {
      console.error(`[webaios] notification du widget ${w.id} :`, e);
    }
  }

  /**
   * Récolte ce widget tout de suite (après la récolte en cours) et rend son nouvel état, avec l'id de l'exécution écrite
   * (aucune si rien n'a tourné : atelier arrêté, noyau qui s'arrête, accord retiré pendant).
   */
  async recolterMaintenant(id: string, declencheur: Execution["declencheur"] = "manuelle"): Promise<EtatWidget & { execution?: string }> {
    const demande = this.demande(id);
    await this.attendrePret();
    try {
      return await this.dansSaVoie(id, async (w) => {
        demande.commencee();
        if (!w) throw new Error(`Widget inconnu : ${id}`);
        if (this.arrete) return lireEtatWidget(this.o.dossierWidgets, id);
        if (!(await this.atelierDemarre())) return this.marquerAtelierArrete(w);
        if (this.arrete) return lireEtatWidget(this.o.dossierWidgets, id);
        return this.recolter(w, declencheur);
      });
    } finally {
      demande.commencee();
    }
  }

  /**
   * Essai du constructeur : rejoue le workflow du widget depuis `depart` avec les sorties amont de l'exécution
   * `origine`, dans la même file que les vraies exécutions (le conteneur porte l'id du widget). Sans atelier, refusé
   * sans toucher à l'état du widget.
   */
  async rejouer(id: string, origine: string, depart: string): Promise<ResultatEssai> {
    const demande = this.demande(id);
    await this.attendrePret();
    // L'essai suit la voie de son widget.
    try {
      return await this.dansSaVoie(id, async (w): Promise<ResultatEssai> => {
        demande.commencee();
        if (!w) return { ok: false, erreur: `Widget inconnu : ${id}` };
        if (this.arrete) return { ok: false, erreur: ERREUR_INTERROMPUE };
        if (!(await this.atelierDemarre())) return { ok: false, erreur: ERREUR_ATELIER_ARRETE };
        if (this.arrete) return { ok: false, erreur: ERREUR_INTERROMPUE };
        try {
          return await this.suivre(
            id,
            "essai",
            (surTrace, ia) => this.o.recolterEssai({ ...this.optionsRecolte(w, surTrace, ia), declencheur: "rejeu", origine, depart }),
            (r) => (r.ok ? r.execution : undefined),
          );
        } catch (e) {
          // Le texte de l'exception peut citer ce que le widget a lu : seul un message fixe du noyau est rendu.
          console.error(`[webaios] essai du widget ${id} :`, e);
          return { ok: false, erreur: ERREUR_RECOLTE_INTERNE };
        }
      });
    } finally {
      demande.commencee();
    }
  }

  private async supprimerConteneurs(): Promise<void> {
    await Promise.all([...this.enCoursIds].map((id) => this.o.atelier.supprimerRecolte(id).catch(() => {})));
  }

  /**
   * Coupe la minuterie ; les récoltes en cours (une par voie au plus) sont tuées dans leur conteneur et attendues, de
   * façon bornée : une veille interrompue doit encore écrire sa mémoire et son exécution « interrompue ».
   */
  async arreter(): Promise<void> {
    clearInterval(this.minuterie);
    this.arrete = true;
    await this.supprimerConteneurs();
    // Borné : quitter le navigateur ne doit pas attendre une récolte qui aurait échappé à l'arrêt.
    const tout = Promise.all([this.files.courte, this.files.longue, ...this.parWidget.values()].map((x) => x.catch(() => {})));
    let minuterie: NodeJS.Timeout | undefined;
    await Promise.race([tout, new Promise((ok) => (minuterie = setTimeout(ok, this.o.attenteArretMs ?? ATTENTE_ARRET_MS)))]);
    clearTimeout(minuterie);
    // Toujours pas finies : leur conteneur a pu démarrer après la première suppression.
    await this.supprimerConteneurs();
  }
}
