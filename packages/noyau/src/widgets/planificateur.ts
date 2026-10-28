import type { CheminsEspace } from "../chemins.js";
import { ecrireEtatWidget, lireEtatWidget } from "../accueil/donnees.js";
import { lireAccueil } from "../accueil/lire.js";
import type { EtatWidget, WidgetLu } from "../accueil/schemas.js";
import type { Atelier } from "../conteneur/atelier.js";
import type { IaLocale } from "../ia/ia-locale.js";
import type { PontNavigateur } from "../mcp/pont.js";
import { executerRecolte, type OptionsRecolte } from "./recolte.js";

const MINUTE = 60_000;
/** Une récolte en erreur est retentée au plus tôt 15 min après sa dernière tentative. */
const REESSAI_ERREUR_MS = 15 * MINUTE;
const ATTENTE_ARRET_MS = 15_000;
export const ERREUR_ATELIER_ARRETE = "Mise à jour impossible : atelier arrêté";

const age = (iso: string | null, maintenant: Date) => (iso ? maintenant.getTime() - Date.parse(iso) : Infinity);

/**
 * Le widget est-il à récolter maintenant ? Il faut une récolte (déclarée et `recolte.mjs` présent), un statut autre
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

export type Recolteuse = (o: OptionsRecolte) => Promise<{ etat: EtatWidget; donnees?: unknown }>;

export interface OptionsPlanificateur {
  chemins: CheminsEspace;
  dossierWidgets: string;
  recolteur: string;
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
}

/** Lance les récoltes des widgets en arrière-plan, une à la fois, tant que le navigateur est ouvert. */
export class PlanificateurWidgets {
  private readonly o: OptionsPlanificateur & { horloge: () => Date; intervalleMs: number; recolter: Recolteuse };
  private minuterie: NodeJS.Timeout | undefined;
  /** Une récolte à la fois : chaque récolte s'enchaîne sur la précédente. */
  private file: Promise<unknown> = Promise.resolve();
  private verification: Promise<string[]> | null = null;
  /** Widget dont la récolte tourne en ce moment. */
  private courant: string | null = null;
  private arrete = false;

  constructor(o: OptionsPlanificateur) {
    // `??` plutôt qu'un spread : une option passée explicitement à undefined garde sa valeur par défaut.
    this.o = {
      ...o,
      horloge: o.horloge ?? (() => new Date()),
      intervalleMs: o.intervalleMs ?? MINUTE,
      recolter: o.recolter ?? executerRecolte,
    };
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

  private async verifierMaintenant(o: { auLancement: boolean }): Promise<string[]> {
    const dus = (await this.widgets()).filter((w) => widgetDu(w, this.o.horloge(), o)).map((w) => w.id);
    if (!dus.length) return [];
    const recoltes: string[] = [];
    for (const id of dus) {
      if (this.arrete) break;
      // Relu sous le verrou : une récolte demandée entre-temps a pu le mettre à jour.
      const fait = await this.enchainer(async () => {
        const w = (await this.widgets()).find((x) => x.id === id);
        if (!w || !widgetDu(w, this.o.horloge(), o) || this.arrete) return false;
        if (!(await this.atelierDemarre())) {
          await this.marquerAtelierArrete(w);
          return false;
        }
        await this.recolter(w);
        return true;
      });
      if (fait) recoltes.push(id);
    }
    return recoltes;
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
    };
    await ecrireEtatWidget(this.o.dossierWidgets, w.id, etat);
    this.o.surChange?.();
    return etat;
  }

  private async recolter(w: WidgetLu): Promise<EtatWidget> {
    const avant = await lireEtatWidget(this.o.dossierWidgets, w.id);
    this.courant = w.id;
    let etat: EtatWidget;
    try {
      ({ etat } = await this.o.recolter({
        id: w.id,
        widget: w,
        dossierWidgets: this.o.dossierWidgets,
        recolteur: this.o.recolteur,
        atelier: this.o.atelier,
        ia: this.o.ia,
        pont: this.o.pont,
        horloge: this.o.horloge,
        ...(this.o.surChange ? { surChange: this.o.surChange } : {}),
      }));
    } finally {
      this.courant = null;
    }
    // Arrêt du noyau pendant la récolte (sortie, changement de profil) : elle n'a pas échoué, elle reprendra plus tard.
    if (this.arrete && etat.statut === "erreur") {
      await ecrireEtatWidget(this.o.dossierWidgets, w.id, avant);
      this.o.surChange?.();
      return avant;
    }
    return etat;
  }

  /** Récolte ce widget tout de suite (après la récolte en cours) et rend son nouvel état. */
  recolterMaintenant(id: string): Promise<EtatWidget> {
    return this.enchainer(async () => {
      const w = (await this.widgets()).find((x) => x.id === id);
      if (!w) throw new Error(`Widget inconnu : ${id}`);
      if (this.arrete) return lireEtatWidget(this.o.dossierWidgets, id);
      if (!(await this.atelierDemarre())) return this.marquerAtelierArrete(w);
      return this.recolter(w);
    });
  }

  /** Coupe la minuterie ; une récolte en cours est tuée dans son conteneur et attendue, de façon bornée. */
  async arreter(): Promise<void> {
    clearInterval(this.minuterie);
    this.arrete = true;
    if (this.courant) await this.o.atelier.supprimerRecolte(this.courant).catch(() => {});
    // Borné : quitter le navigateur ne doit pas attendre une récolte qui aurait échappé à l'arrêt.
    let minuterie: NodeJS.Timeout | undefined;
    await Promise.race([this.file.catch(() => {}), new Promise((ok) => (minuterie = setTimeout(ok, ATTENTE_ARRET_MS)))]);
    clearTimeout(minuterie);
  }
}
