import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CheminsEspace } from "../chemins.js";
import { ecrireEtatWidget, lireEtatWidget } from "../accueil/donnees.js";
import { lireAccueil } from "../accueil/lire.js";
import type { EtatWidget, WidgetLu } from "../accueil/schemas.js";
import type { Atelier } from "../conteneur/atelier.js";
import type { IaLocale } from "../ia/ia-locale.js";
import type { PontNavigateur } from "../mcp/pont.js";
import { lireAccords, retirerAccord } from "./accords.js";
import type { TraceDirecte } from "../workflows/executer.js";
import { lireExecution, type Execution } from "../workflows/executions.js";
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
/** L'exécution (vraie, ou essai du constructeur) qui tourne en ce moment. */
export type DirectWidget = { widget: string; genre: "execution" | "essai"; debut: string; blocs: Record<string, BlocDirect> };
/** `enAttente` : widgets dont une demande (récolte manuelle, essai) attend son tour dans la file. */
export type EtatDirect = { courant: DirectWidget | null; enAttente: string[] };

const MINUTE = 60_000;
/** Une récolte en erreur est retentée au plus tôt 15 min après sa dernière tentative. */
const REESSAI_ERREUR_MS = 15 * MINUTE;
const ATTENTE_ARRET_MS = 15_000;
const ID_WIDGET = /^[a-z0-9-]+$/;

const age = (iso: string | null, maintenant: Date) => (iso ? maintenant.getTime() - Date.parse(iso) : Infinity);

/**
 * Le widget est-il à récolter maintenant ? Il faut une récolte (déclarée, et `workflow.json` ou `recolte.mjs` présent), un statut autre
 * qu'`accord-requis` (seul l'utilisateur débloque), et des données plus vieilles que `recolte.minutes` (ou absentes). Après une
 * erreur, on attend en plus 15 min depuis la dernière tentative. `en-cours` n'est relancé qu'au lancement (la récolte
 * précédente a été interrompue) : sinon, c'est la nôtre qui tourne.
 */
export function widgetDu(w: WidgetLu, maintenant: Date, o: { auLancement: boolean }): boolean {
  if ("erreur" in w || !w.aRecolte || !w.declaration.recolte) return false;
  const { statut, derniereMaj, derniereTentative } = w.etat;
  if (statut === "accord-requis") return false;
  if (statut === "en-cours") return o.auLancement;
  if (age(derniereMaj, maintenant) < w.declaration.recolte.minutes * MINUTE) return false;
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
  /**
   * Démarrage de l'atelier : aucune vérification ni récolte avant sa fin (sinon chaque lancement afficherait un bref
   * « atelier arrêté » pendant que le conteneur démarre).
   */
  pret?: Promise<unknown>;
  /** Attente bornée d'une récolte en cours à l'arrêt (15 s par défaut). */
  attenteArretMs?: number;
}

/** Lance les récoltes des widgets en arrière-plan, une à la fois, tant que le navigateur est ouvert. */
export class PlanificateurWidgets {
  private readonly o: OptionsPlanificateur & { horloge: () => Date; intervalleMs: number; recolter: Recolteuse; recolterEssai: Essayeuse };
  private minuterie: NodeJS.Timeout | undefined;
  /** Une récolte à la fois : chaque récolte s'enchaîne sur la précédente. */
  private file: Promise<unknown> = Promise.resolve();
  private verification: Promise<string[]> | null = null;
  /** Widget dont la récolte tourne en ce moment. */
  private courant: string | null = null;
  private arrete = false;
  /** L'exécution suivie en direct (celle qui tourne vraiment, pas une vérification sans récolte). */
  private enDirect: DirectWidget | null = null;
  /** Widgets des demandes en file, pas encore commencées (un par demande). */
  private attente: string[] = [];

  constructor(o: OptionsPlanificateur) {
    // `??` plutôt qu'un spread : une option passée explicitement à undefined garde sa valeur par défaut.
    this.o = {
      ...o,
      horloge: o.horloge ?? (() => new Date()),
      intervalleMs: o.intervalleMs ?? MINUTE,
      recolter: o.recolter ?? executerRecolte,
      recolterEssai: o.recolterEssai ?? executerEssai,
    };
  }

  /** Ce qui tourne en ce moment, et les demandes qui attendent leur tour. */
  direct(): EtatDirect {
    return { courant: this.enDirect, enAttente: [...new Set(this.attente)] };
  }

  /** Une erreur du rappel ne doit jamais arrêter une exécution. */
  private signalerDirect(): void {
    if (!this.o.surDirect) return;
    try {
      this.o.surDirect(structuredClone(this.direct()));
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
    f: (surTrace: (t: TraceDirecte) => void) => Promise<T>,
    executionDe: (r: T) => string | undefined,
  ): Promise<T> {
    const suivi: DirectWidget = { widget, genre, debut: this.o.horloge().toISOString(), blocs: {} };
    this.enDirect = suivi;
    this.signalerDirect();
    const surTrace = (t: TraceDirecte) => {
      if (this.enDirect !== suivi) return;
      suivi.blocs[t.bloc] = t.etape === "debut" ? { statut: "en-cours", elements: null } : { statut: t.statut, elements: t.elements };
      this.signalerDirect();
    };
    let r: T | undefined;
    try {
      r = await f(surTrace);
      return r;
    } finally {
      await this.resynchroniser(suivi, r === undefined ? undefined : executionDe(r));
      if (this.enDirect === suivi) this.enDirect = null;
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
    if (this.enDirect === suivi) this.signalerDirect();
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

  /** Lance les récoltes dues ; rend les ids récoltés. Une seule vérification à la fois. */
  async verifier(o: { auLancement: boolean }): Promise<string[]> {
    if (this.verification || this.arrete) return [];
    this.verification = this.verifierMaintenant(o).finally(() => (this.verification = null));
    return this.verification;
  }

  private async widgets(): Promise<WidgetLu[]> {
    return (await lireAccueil(this.o.chemins, this.o.dossierWidgets)).widgets;
  }

  private async attendrePret(): Promise<void> {
    await this.o.pret?.catch(() => {});
  }

  private async verifierMaintenant(o: { auLancement: boolean }): Promise<string[]> {
    await this.attendrePret();
    if (this.arrete) return [];
    await this.enchainer(() => this.oublierWidgetsDisparus());
    const dus = (await this.widgets()).filter((w) => widgetDu(w, this.o.horloge(), o)).map((w) => w.id);
    if (!dus.length) return [];
    const recoltes: string[] = [];
    for (const id of dus) {
      if (this.arrete) break;
      // Relu sous le verrou : une récolte demandée entre-temps a pu le mettre à jour.
      const fait = await this.enchainer(() =>
        this.enCours(id, async () => {
          const w = (await this.widgets()).find((x) => x.id === id);
          if (!w || !widgetDu(w, this.o.horloge(), o) || this.arrete) return false;
          if (!(await this.atelierDemarre())) {
            await this.marquerAtelierArrete(w);
            return false;
          }
          if (this.arrete) return false;
          await this.recolter(w, "planifiee");
          return true;
        }),
      );
      if (fait) recoltes.push(id);
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
    const presents = new Set((await this.widgets()).map((w) => w.id));
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
    this.courant = id;
    try {
      return await f();
    } finally {
      if (this.courant === id) this.courant = null;
    }
  }

  private enchainer<T>(f: () => Promise<T>): Promise<T> {
    const suivante = this.file.catch(() => {}).then(f);
    this.file = suivante;
    return suivante;
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

  private optionsRecolte(w: WidgetLu, surTrace: (t: TraceDirecte) => void): OptionsRecolte {
    return {
      id: w.id,
      widget: w,
      dossierWidgets: this.o.dossierWidgets,
      moteur: this.o.moteur,
      atelier: this.o.atelier,
      ia: this.o.ia,
      pont: this.o.pont,
      horloge: this.o.horloge,
      ...(this.o.surChange ? { surChange: this.o.surChange } : {}),
      ...(this.o.adressesLocales ? { adressesLocales: true } : {}),
      interrompue: () => this.arrete,
      surTrace,
    };
  }

  private async recolter(w: WidgetLu, declencheur: Execution["declencheur"]): Promise<EtatWidget & { execution?: string }> {
    const avant = await lireEtatWidget(this.o.dossierWidgets, w.id);
    let etat: EtatWidget;
    let execution: string | undefined;
    try {
      ({ etat, execution } = await this.suivre(
        w.id,
        "execution",
        (surTrace) => this.o.recolter({ ...this.optionsRecolte(w, surTrace), declencheur }),
        (r) => r.execution,
      ));
    } catch (e) {
      // La récolte a pu écrire en-cours avant d'échouer (disque, conteneur…) : le widget ne doit pas y rester. Le texte
      // de l'exception n'est pas gardé (il peut citer ce que le widget a lu) : seul un message fixe du noyau l'est.
      console.error(`[webaios] récolte du widget ${w.id} :`, e);
      etat = this.arrete
        ? avant
        : { statut: "erreur", derniereMaj: avant.derniereMaj, derniereTentative: this.o.horloge().toISOString(), erreur: ERREUR_RECOLTE_INTERNE, erreurNoyau: true };
      await ecrireEtatWidget(this.o.dossierWidgets, w.id, etat);
      this.o.surChange?.();
      return etat;
    }
    // Arrêt du noyau pendant la récolte (sortie, changement de profil) : elle n'a pas échoué, elle reprendra plus tard.
    if (this.arrete && etat.statut === "erreur") {
      await ecrireEtatWidget(this.o.dossierWidgets, w.id, avant);
      this.o.surChange?.();
      return { ...avant, ...(execution ? { execution } : {}) };
    }
    return { ...etat, ...(execution ? { execution } : {}) };
  }

  /**
   * Récolte ce widget tout de suite (après la récolte en cours) et rend son nouvel état, avec l'id de l'exécution écrite
   * (aucune si rien n'a tourné : atelier arrêté, noyau qui s'arrête, accord retiré pendant).
   */
  async recolterMaintenant(id: string, declencheur: Execution["declencheur"] = "manuelle"): Promise<EtatWidget & { execution?: string }> {
    const demande = this.demande(id);
    await this.attendrePret();
    return this.enchainer(() =>
      this.enCours(id, async () => {
        demande.commencee();
        const w = (await this.widgets()).find((x) => x.id === id);
        if (!w) throw new Error(`Widget inconnu : ${id}`);
        if (this.arrete) return lireEtatWidget(this.o.dossierWidgets, id);
        if (!(await this.atelierDemarre())) return this.marquerAtelierArrete(w);
        if (this.arrete) return lireEtatWidget(this.o.dossierWidgets, id);
        return this.recolter(w, declencheur);
      }),
    );
  }

  /**
   * Essai du constructeur : rejoue le workflow du widget depuis `depart` avec les sorties amont de l'exécution
   * `origine`, dans la même file que les vraies exécutions (le conteneur porte l'id du widget). Sans atelier, refusé
   * sans toucher à l'état du widget.
   */
  async rejouer(id: string, origine: string, depart: string): Promise<ResultatEssai> {
    const demande = this.demande(id);
    await this.attendrePret();
    return this.enchainer(() =>
      this.enCours(id, async (): Promise<ResultatEssai> => {
        demande.commencee();
        const w = (await this.widgets()).find((x) => x.id === id);
        if (!w) return { ok: false, erreur: `Widget inconnu : ${id}` };
        if (this.arrete) return { ok: false, erreur: ERREUR_INTERROMPUE };
        if (!(await this.atelierDemarre())) return { ok: false, erreur: ERREUR_ATELIER_ARRETE };
        if (this.arrete) return { ok: false, erreur: ERREUR_INTERROMPUE };
        try {
          return await this.suivre(
            id,
            "essai",
            (surTrace) => this.o.recolterEssai({ ...this.optionsRecolte(w, surTrace), declencheur: "rejeu", origine, depart }),
            (r) => (r.ok ? r.execution : undefined),
          );
        } catch (e) {
          // Le texte de l'exception peut citer ce que le widget a lu : seul un message fixe du noyau est rendu.
          console.error(`[webaios] essai du widget ${id} :`, e);
          return { ok: false, erreur: ERREUR_RECOLTE_INTERNE };
        }
      }),
    );
  }

  /** Coupe la minuterie ; une récolte en cours est tuée dans son conteneur et attendue, de façon bornée. */
  async arreter(): Promise<void> {
    clearInterval(this.minuterie);
    this.arrete = true;
    if (this.courant) await this.o.atelier.supprimerRecolte(this.courant).catch(() => {});
    // Borné : quitter le navigateur ne doit pas attendre une récolte qui aurait échappé à l'arrêt.
    let minuterie: NodeJS.Timeout | undefined;
    await Promise.race([this.file.catch(() => {}), new Promise((ok) => (minuterie = setTimeout(ok, this.o.attenteArretMs ?? ATTENTE_ARRET_MS)))]);
    clearTimeout(minuterie);
    // Toujours pas finie : son conteneur a pu démarrer après la première suppression.
    if (this.courant) await this.o.atelier.supprimerRecolte(this.courant).catch(() => {});
  }
}
