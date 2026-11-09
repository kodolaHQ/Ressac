import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { CheminsEspace } from "../chemins.js";
import type { Atelier } from "../conteneur/atelier.js";
import type { AccesIaExecution } from "../ia/repartiteur.js";
import type { PontNavigateur } from "../mcp/pont.js";
import { COMPOSANTS_INTEGRES } from "../pages/catalogue.js";
import { lireComposantsAgent } from "../pages/composants-agent.js";
import { mettreEnPage } from "../pages/mise-en-page.js";
import { accordValide, lireAccords, retirerAccord } from "../widgets/accords.js";
import { chaineOrigine, marquerInterrompue } from "../widgets/recolte.js";
import { message, tronquer } from "../workflows/acces.js";
import {
  ERREUR_MAX,
  MEMOIRE_NON_GARDEE,
  delaisExecution,
  executerWorkflow,
  type ContexteWorkflow,
  type IssueWorkflow,
  type LanceurProcessus,
  type TraceDirecte,
} from "../workflows/executer.js";
import { ID_EXECUTION, ecrireExecution, idEssai, type Execution } from "../workflows/executions.js";
import type { Menagement } from "../workflows/menagement.js";
import { avecMemoire, ecrireMemoire, lireMemoire } from "../workflows/memoire.js";
import { debutTropGros } from "../workflows/protocole.js";
import { REJEU_TROP_GROS, planRejeu } from "../workflows/rejeu.js";
import type { Proprietaire } from "../workflows/schema.js";
import { ecrireResultat, supprimerDonneesAction } from "./donnees.js";
import { lireAction, workflowDeLAction } from "./lire.js";
import type { DeclarationAction } from "./schemas.js";

export const ACTION_INCONNUE = "Action inconnue";
export const saisieRequise = (libelle: string) => `Saisie requise : ${libelle}`;
/** Same text as for a widget. */
export const accordRequisAction = (d: DeclarationAction) => `Accord requis pour lire avec ton compte : ${d.sources.compte.join(", ")}`;
export const ACTION_SANS_WORKFLOW = "Cette action n'a pas de workflow.json";
export const RESULTAT_TROP_GROS = "Résultats trop gros pour être gardés";
/** Maximum length of the kept input (that of `Execution.saisie`). */
export const SAISIE_MAX = 200;

/** The outcome of a launch: `invalide` when nothing ran (unknown action, invalid workflow, missing input…). */
export type ResultatLancement = { statut: Execution["statut"] | "invalide"; execution?: string; erreur?: string; erreurNoyau?: true };

/** A trace of an action's workflow, with its block type (the page shows its label from the catalog). */
export type TraceAction = TraceDirecte & { type?: string };

export interface OptionsAction {
  id: string;
  chemins: CheminsEspace;
  /** Runs, results, memory and grants of actions, outside the workspace (`<profile>/actions`). */
  dossierActions: string;
  moteur: string;
  atelier: Pick<Atelier, "commandeRecolte" | "supprimerRecolte">;
  lancer?: LanceurProcessus;
  pont: PontNavigateur;
  /** This run's access to the local AI (priority), for blocks and layout; null without AI. */
  ia: AccesIaExecution | null;
  horloge?: () => Date;
  saisie: string | null;
  declencheur: Execution["declencheur"];
  /** « Stop »: raised during the workflow, the run is interrupted; during the layout, the fallback one. */
  signal: AbortSignal;
  surTrace(t: TraceAction): void;
  surEtape(e: "mise-en-page"): void;
  /** A builder trial: replays from `depart` with the upstream outputs of run `origine`. */
  essai?: { origine: string; depart: string };
  /** True when the kernel stops: the run is then « interrupted » by WebAiOs, not by the user. */
  interrompue?: () => boolean;
  adressesLocales?: boolean;
  menagement?: Menagement;
  urlRecherche?: string;
  delaiMiseEnPageMs?: number;
}

/** The input as it is kept and sent: trimmed, at most `SAISIE_MAX` characters; null if empty. */
export function couperSaisie(saisie: string | null | undefined): string | null {
  let s = (saisie ?? "").trim().slice(0, SAISIE_MAX);
  // No half character at the end.
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  s = s.trimEnd();
  return s === "" ? null : s;
}

const refus = (erreur: string, noyau = true): ResultatLancement => ({ statut: "invalide", erreur, ...(noyau ? { erreurNoyau: true as const } : {}) });

/** Like the widgets' `accordEnRegle`: a stale grant is withdrawn, and what was read with it erased. */
async function accordEnRegle(dossierActions: string, id: string, d: DeclarationAction): Promise<boolean> {
  const enregistre = (await lireAccords(dossierActions))[id];
  if (enregistre !== undefined && !accordValide(d, enregistre)) {
    await retirerAccord(dossierActions, id);
    await supprimerDonneesAction(dossierActions, id);
  }
  return d.sources.compte.length === 0 || accordValide(d, (await lireAccords(dossierActions))[id]);
}

/**
 * Launches an action: its workflow in the container, then the layout of its result by Gemma (a fallback without
 * it). Kept, in order: the run, the result, the memory (never for a trial). Nothing is written when
 * the action could not run. For an action with an account, the grant is re-read after each write: withdrawn, everything
 * read with it goes. An action whose folder disappeared meanwhile keeps nothing.
 */
export async function executerAction(o: OptionsAction): Promise<ResultatLancement> {
  const { id, chemins, dossierActions } = o;
  const horloge = o.horloge ?? (() => new Date());
  const action = await lireAction(chemins, id);
  if (!action) return refus(ACTION_INCONNUE);
  // The read error of action.json quotes its content (key names): it is not a fixed kernel text.
  if ("erreur" in action) return refus(action.erreur, false);
  const wf = await workflowDeLAction(action);
  if (wf.t === "absent") return refus(ACTION_SANS_WORKFLOW);
  if (wf.t !== "ok") return refus(tronquer(wf.erreur, ERREUR_MAX), wf.t !== "illisible");
  const { valide } = wf;
  const { declaration } = action;
  const dossierDonnees = join(dossierActions, id);
  const proprietaire: Proprietaire = { type: "action", id };
  const typesBlocs = new Map(valide.workflow.blocs.map((b) => [b.id, b.type]));

  // A trial resumes the upstream outputs of a run: its input too, in the absence of a new one.
  const rejeu = o.essai ? await chaineOrigine(dossierDonnees, o.essai.origine) : null;
  const saisie = declaration.saisie ? couperSaisie(o.saisie ?? rejeu?.[0]?.saisie ?? null) : null;
  if (declaration.saisie && saisie === null) return refus(saisieRequise(declaration.saisie.libelle));

  if (!(await accordEnRegle(dossierActions, id, declaration))) {
    return { statut: "accord-requis", erreur: accordRequisAction(declaration), erreurNoyau: true };
  }

  let plan: Extract<ReturnType<typeof planRejeu>, { ok: true }> | null = null;
  if (o.essai && rejeu) {
    const p = planRejeu(valide, rejeu[0], o.essai.depart, rejeu[1]);
    if (!p.ok) return refus(p.erreur);
    const { limiteMs } = delaisExecution(declaration.dureeMaxMinutes);
    const workflow = { blocs: valide.workflow.blocs, liens: valide.workflow.liens, ordre: valide.ordre };
    const debut = {
      precedent: null,
      maintenant: horloge().toISOString(),
      config: null,
      workflow,
      rejeu: { relances: p.relances, sorties: p.sorties },
      ...(limiteMs !== undefined ? { limiteMs } : {}),
      ...(saisie !== null ? { saisie } : {}),
      avancement: true as const,
    };
    if (debutTropGros(debut)) return refus(REJEU_TROP_GROS);
    plan = p;
  }

  const contexteAccord: Pick<ContexteWorkflow, "accord" | "surProfilRefuse" | "messageAccordRequis" | "sources"> = {
    sources: declaration.sources,
    async accord() {
      const a = (await lireAccords(dossierActions))[id];
      return accordValide(declaration, a) ? { profil: a.profil } : null;
    },
    async surProfilRefuse() {
      await retirerAccord(dossierActions, id);
      await supprimerDonneesAction(dossierActions, id);
    },
    messageAccordRequis: accordRequisAction(declaration),
  };
  const dureeMaxMinutes = declaration.dureeMaxMinutes;
  const { issue, execution } = await executerWorkflow(
    {
      proprietaire,
      valide,
      dossierFichiers: action.dossier,
      config: null,
      precedent: null,
      // A trial neither receives nor keeps any memory.
      memoire: plan ? {} : await lireMemoire(dossierDonnees),
      ...contexteAccord,
      declencheur: o.declencheur,
      ...(plan ? { rejeu: { relances: plan.relances, sorties: plan.sorties, repris: plan.repris } } : {}),
      ...(dureeMaxMinutes !== undefined ? { dureeMaxMinutes } : {}),
      ...(saisie !== null ? { saisie } : {}),
      avancement: true,
      signal: o.signal,
    },
    {
      moteur: o.moteur,
      atelier: o.atelier,
      ...(o.lancer ? { lancer: o.lancer } : {}),
      ia: o.ia,
      pont: o.pont,
      horloge,
      surTrace: (t) => o.surTrace({ ...t, ...(typesBlocs.has(t.bloc) ? { type: typesBlocs.get(t.bloc)! } : {}) }),
      ...(o.adressesLocales ? { adressesLocales: true } : {}),
      ...(o.menagement ? { menagement: o.menagement } : {}),
      ...(o.urlRecherche !== undefined ? { urlRecherche: o.urlRecherche } : {}),
    },
  );
  if (issue.t === "arret" && issue.erreur === REJEU_TROP_GROS) return refus(REJEU_TROP_GROS);
  if (plan && o.essai) {
    execution.id = idEssai(execution.debut);
    execution.essai = { depart: o.essai.depart, origine: plan.origine };
  }

  const accordRetire = async () => declaration.sources.compte.length > 0 && !accordValide(declaration, (await lireAccords(dossierActions))[id]);
  const presente = async () => (await lireAction(chemins, id)) !== null;
  // What this run wrote: only what can be taken back if the action disappeared in the meantime.
  let executionEcrite = false;
  let resultatEcrit = false;
  const garderExecution = async () => {
    await ecrireExecution(dossierDonnees, execution);
    executionEcrite = true;
  };
  /**
   * What was read with the account goes with the grant (the whole history). An action not found (deleted, or actions folder
   * unmounted for a while, unreadable…) keeps nothing of this run, but its history stays: erasing it
   * is up to `oublierActionsDisparues`, at startup, which can recognize an absent actions folder.
   */
  const perdue = async (): Promise<ResultatLancement | null> => {
    if (await accordRetire()) {
      await supprimerDonneesAction(dossierActions, id);
      return { statut: "accord-requis", erreur: messageRefus(issue, declaration), erreurNoyau: true };
    }
    if (!(await presente())) {
      await oublierCetteExecution(dossierDonnees, execution.id, { execution: executionEcrite, resultat: resultatEcrit });
      return refus(ACTION_INCONNUE);
    }
    return null;
  };
  const avant = await perdue();
  if (avant) return avant;

  const conclusion = (): ResultatLancement => ({
    statut: execution.statut,
    execution: execution.id,
    ...(execution.erreur !== undefined ? { erreur: execution.erreur } : {}),
    ...(execution.erreurNoyau ? { erreurNoyau: true as const } : {}),
  });

  if (issue.t !== "fin") {
    if (o.interrompue?.() === true && execution.statut !== "accord-requis") marquerInterrompue(execution);
    await garderExecution();
    return (await perdue()) ?? conclusion();
  }

  o.surEtape("mise-en-page");
  const resultats = issue.sortie.valeur;
  const catalogue = [...COMPOSANTS_INTEGRES, ...(await lireComposantsAgent(chemins.composants)).valides];
  const page = await mettreEnPage({
    resultats,
    consigne: declaration.miseEnPage ?? null,
    catalogue,
    ia: o.ia,
    signal: o.signal,
    ...(o.delaiMiseEnPageMs !== undefined ? { delaiMs: o.delaiMiseEnPageMs } : {}),
  });
  const pendant = await perdue();
  if (pendant) return pendant;
  // WebAiOs stops during the layout: the run is interrupted, with no result or memory. (The user's « Stop »,
  // on the other hand, keeps the result with the fallback layout.)
  if (o.interrompue?.() === true) {
    marquerInterrompue(execution);
    await garderExecution();
    return (await perdue()) ?? conclusion();
  }

  await garderExecution();
  try {
    await ecrireResultat(dossierActions, id, { version: 1, execution: execution.id, saisie, resultats, plan: page.plan, secours: page.secours, vide: page.vide });
    resultatEcrit = true;
  } catch (e) {
    // Too big (or disk): the run fails kernel-side, with no result.
    console.error(`[webaios] résultat de l'action ${id} :`, message(e));
    execution.statut = "echouee";
    execution.erreur = RESULTAT_TROP_GROS;
    execution.erreurNoyau = true;
    await garderExecution();
    return (await perdue()) ?? conclusion();
  }
  const apresResultat = await perdue();
  if (apresResultat) return apresResultat;

  if (!plan && issue.memoire) {
    // Re-read under the memory lock: a deletion that slipped in since does not leave it written (the erasure
    // of the action's data goes through this same lock).
    const gardee = await avecMemoire(
      dossierDonnees,
      async () => (await accordRetire()) || !(await presente()) || (await ecrireMemoire(dossierDonnees, issue.memoire!)),
    );
    if (!gardee) {
      execution.blocs.find((b) => b.id === valide.sortie.id)?.journal.push(MEMOIRE_NON_GARDEE);
      await garderExecution();
    }
  }
  return (await perdue()) ?? conclusion();
}

/** Removes the run and result written by this run only (same paths as `executions.ts` and `donnees.ts`). */
async function oublierCetteExecution(dossierDonnees: string, execution: string, ecrits: { execution: boolean; resultat: boolean }): Promise<void> {
  if (!ID_EXECUTION.test(execution)) return;
  if (ecrits.resultat) await rm(join(dossierDonnees, "resultats", `${execution}.json`), { force: true }).catch(() => {});
  if (ecrits.execution) await rm(join(dossierDonnees, "executions", `${execution}.json`), { force: true }).catch(() => {});
}

/** The message of an action waiting for a new grant: the engine's if it stopped for that (profile denied…). */
function messageRefus(issue: IssueWorkflow, d: DeclarationAction): string {
  return issue.t === "arret" && issue.statut === "accord-requis" ? issue.erreur : accordRequisAction(d);
}

