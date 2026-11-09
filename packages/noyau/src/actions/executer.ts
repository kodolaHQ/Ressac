import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SpacePaths } from "../chemins.js";
import type { Atelier } from "../conteneur/atelier.js";
import type { AiAccessRun } from "../ia/repartiteur.js";
import type { BrowserBridge } from "../mcp/pont.js";
import { BUILTIN_COMPONENTS } from "../pages/catalogue.js";
import { readAgentComponents } from "../pages/composants-agent.js";
import { layOut } from "../pages/mise-en-page.js";
import { grantValid, lireAccords, retirerAccord } from "../widgets/accords.js";
import { originChain, markInterrupted } from "../widgets/recolte.js";
import { message, truncate } from "../workflows/acces.js";
import {
  MAX_ERROR,
  MEMORY_NOT_KEPT,
  runDelays,
  executerWorkflow,
  type WorkflowContext,
  type IssueWorkflow,
  type ProcessLauncher,
  type DirectTrace,
} from "../workflows/executer.js";
import { ID_EXECUTION, writeRun, attemptId, type Execution } from "../workflows/executions.js";
import type { Pacing } from "../workflows/menagement.js";
import { withMemory, writeMemory, readMemory } from "../workflows/memoire.js";
import { startTooBig } from "../workflows/protocole.js";
import { REPLAY_TOO_BIG, replayPlan } from "../workflows/rejeu.js";
import type { Owner } from "../workflows/schema.js";
import { writeResult, deleteDataAction } from "./donnees.js";
import { lireAction, workflowDeLAction } from "./lire.js";
import type { DeclarationAction } from "./schemas.js";

export const ACTION_UNKNOWN = "Action inconnue";
export const requiredInput = (label: string) => `Saisie requise : ${label}`;
/** Same text as for a widget. */
export const actionGrantRequired = (d: DeclarationAction) => `Accord requis pour lire avec ton compte : ${d.sources.compte.join(", ")}`;
export const ACTION_SANS_WORKFLOW = "Cette action n'a pas de workflow.json";
export const RESULT_TOO_BIG = "Résultats trop gros pour être gardés";
/** Maximum length of the kept input (that of `Execution.saisie`). */
export const INPUT_MAX = 200;

/** The outcome of a launch: `invalide` when nothing ran (unknown action, invalid workflow, missing input…). */
export type LaunchResult = { statut: Execution["statut"] | "invalide"; execution?: string; erreur?: string; erreurNoyau?: true };

/** A trace of an action's workflow, with its block type (the page shows its label from the catalog). */
export type TraceAction = DirectTrace & { type?: string };

export interface OptionsAction {
  id: string;
  chemins: SpacePaths;
  /** Runs, results, memory and grants of actions, outside the workspace (`<profile>/actions`). */
  dossierActions: string;
  moteur: string;
  atelier: Pick<Atelier, "commandeRecolte" | "supprimerRecolte">;
  lancer?: ProcessLauncher;
  pont: BrowserBridge;
  /** This run's access to the local AI (priority), for blocks and layout; null without AI. */
  ia: AiAccessRun | null;
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
  menagement?: Pacing;
  urlRecherche?: string;
  delaiMiseEnPageMs?: number;
}

/** The input as it is kept and sent: trimmed, at most `SAISIE_MAX` characters; null if empty. */
export function cutInput(input: string | null | undefined): string | null {
  let s = (input ?? "").trim().slice(0, INPUT_MAX);
  // No half character at the end.
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  s = s.trimEnd();
  return s === "" ? null : s;
}

const denial = (error: string, noyau = true): LaunchResult => ({ statut: "invalide", erreur: error, ...(noyau ? { erreurNoyau: true as const } : {}) });

/** Like the widgets' `accordEnRegle`: a stale grant is withdrawn, and what was read with it erased. */
async function accordEnRegle(dossierActions: string, id: string, d: DeclarationAction): Promise<boolean> {
  const saved = (await lireAccords(dossierActions))[id];
  if (saved !== undefined && !grantValid(d, saved)) {
    await retirerAccord(dossierActions, id);
    await deleteDataAction(dossierActions, id);
  }
  return d.sources.compte.length === 0 || grantValid(d, (await lireAccords(dossierActions))[id]);
}

/**
 * Launches an action: its workflow in the container, then the layout of its result by Gemma (a fallback without
 * it). Kept, in order: the run, the result, the memory (never for a trial). Nothing is written when
 * the action could not run. For an action with an account, the grant is re-read after each write: withdrawn, everything
 * read with it goes. An action whose folder disappeared meanwhile keeps nothing.
 */
export async function executerAction(o: OptionsAction): Promise<LaunchResult> {
  const { id, chemins: paths, dossierActions } = o;
  const clock = o.horloge ?? (() => new Date());
  const action = await lireAction(paths, id);
  if (!action) return denial(ACTION_UNKNOWN);
  // The read error of action.json quotes its content (key names): it is not a fixed kernel text.
  if ("erreur" in action) return denial(action.erreur, false);
  const wf = await workflowDeLAction(action);
  if (wf.t === "absent") return denial(ACTION_SANS_WORKFLOW);
  if (wf.t !== "ok") return denial(truncate(wf.erreur, MAX_ERROR), wf.t !== "illisible");
  const { valide: valid } = wf;
  const { declaration } = action;
  const dataFolder = join(dossierActions, id);
  const owner: Owner = { type: "action", id };
  const typesBlocs = new Map(valid.workflow.blocs.map((b) => [b.id, b.type]));

  // A trial resumes the upstream outputs of a run: its input too, in the absence of a new one.
  const replay = o.essai ? await originChain(dataFolder, o.essai.origine) : null;
  const input = declaration.saisie ? cutInput(o.saisie ?? replay?.[0]?.saisie ?? null) : null;
  if (declaration.saisie && input === null) return denial(requiredInput(declaration.saisie.libelle));

  if (!(await accordEnRegle(dossierActions, id, declaration))) {
    return { statut: "accord-requis", erreur: actionGrantRequired(declaration), erreurNoyau: true };
  }

  let plan: Extract<ReturnType<typeof replayPlan>, { ok: true }> | null = null;
  if (o.essai && replay) {
    const p = replayPlan(valid, replay[0], o.essai.depart, replay[1]);
    if (!p.ok) return denial(p.erreur);
    const { limiteMs: limitMs } = runDelays(declaration.dureeMaxMinutes);
    const workflow = { blocs: valid.workflow.blocs, liens: valid.workflow.liens, ordre: valid.ordre };
    const debut = {
      precedent: null,
      maintenant: clock().toISOString(),
      config: null,
      workflow,
      rejeu: { relances: p.relances, sorties: p.sorties },
      ...(limitMs !== undefined ? { limiteMs: limitMs } : {}),
      ...(input !== null ? { saisie: input } : {}),
      avancement: true as const,
    };
    if (startTooBig(debut)) return denial(REPLAY_TOO_BIG);
    plan = p;
  }

  const grantContext: Pick<WorkflowContext, "accord" | "surProfilRefuse" | "messageAccordRequis" | "sources"> = {
    sources: declaration.sources,
    async accord() {
      const a = (await lireAccords(dossierActions))[id];
      return grantValid(declaration, a) ? { profil: a.profil } : null;
    },
    async surProfilRefuse() {
      await retirerAccord(dossierActions, id);
      await deleteDataAction(dossierActions, id);
    },
    messageAccordRequis: actionGrantRequired(declaration),
  };
  const maxDurationMinutes = declaration.dureeMaxMinutes;
  const { issue, execution } = await executerWorkflow(
    {
      proprietaire: owner,
      valide: valid,
      dossierFichiers: action.dossier,
      config: null,
      precedent: null,
      // A trial neither receives nor keeps any memory.
      memoire: plan ? {} : await readMemory(dataFolder),
      ...grantContext,
      declencheur: o.declencheur,
      ...(plan ? { rejeu: { relances: plan.relances, sorties: plan.sorties, repris: plan.repris } } : {}),
      ...(maxDurationMinutes !== undefined ? { dureeMaxMinutes: maxDurationMinutes } : {}),
      ...(input !== null ? { saisie: input } : {}),
      avancement: true,
      signal: o.signal,
    },
    {
      moteur: o.moteur,
      atelier: o.atelier,
      ...(o.lancer ? { lancer: o.lancer } : {}),
      ia: o.ia,
      pont: o.pont,
      horloge: clock,
      surTrace: (t) => o.surTrace({ ...t, ...(typesBlocs.has(t.bloc) ? { type: typesBlocs.get(t.bloc)! } : {}) }),
      ...(o.adressesLocales ? { adressesLocales: true } : {}),
      ...(o.menagement ? { menagement: o.menagement } : {}),
      ...(o.urlRecherche !== undefined ? { urlRecherche: o.urlRecherche } : {}),
    },
  );
  if (issue.t === "arret" && issue.erreur === REPLAY_TOO_BIG) return denial(REPLAY_TOO_BIG);
  if (plan && o.essai) {
    execution.id = attemptId(execution.debut);
    execution.essai = { depart: o.essai.depart, origine: plan.origine };
  }

  const accordRetire = async () => declaration.sources.compte.length > 0 && !grantValid(declaration, (await lireAccords(dossierActions))[id]);
  const present = async () => (await lireAction(paths, id)) !== null;
  // What this run wrote: only what can be taken back if the action disappeared in the meantime.
  let runWritten = false;
  let writtenResult = false;
  const keepRun = async () => {
    await writeRun(dataFolder, execution);
    runWritten = true;
  };
  /**
   * What was read with the account goes with the grant (the whole history). An action not found (deleted, or actions folder
   * unmounted for a while, unreadable…) keeps nothing of this run, but its history stays: erasing it
   * is up to `oublierActionsDisparues`, at startup, which can recognize an absent actions folder.
   */
  const lost = async (): Promise<LaunchResult | null> => {
    if (await accordRetire()) {
      await deleteDataAction(dossierActions, id);
      return { statut: "accord-requis", erreur: denialMessage(issue, declaration), erreurNoyau: true };
    }
    if (!(await present())) {
      await forgetThisRun(dataFolder, execution.id, { execution: runWritten, resultat: writtenResult });
      return denial(ACTION_UNKNOWN);
    }
    return null;
  };
  const before = await lost();
  if (before) return before;

  const conclusion = (): LaunchResult => ({
    statut: execution.statut,
    execution: execution.id,
    ...(execution.erreur !== undefined ? { erreur: execution.erreur } : {}),
    ...(execution.erreurNoyau ? { erreurNoyau: true as const } : {}),
  });

  if (issue.t !== "fin") {
    if (o.interrompue?.() === true && execution.statut !== "accord-requis") markInterrupted(execution);
    await keepRun();
    return (await lost()) ?? conclusion();
  }

  o.surEtape("mise-en-page");
  const results = issue.sortie.valeur;
  const catalogue = [...BUILTIN_COMPONENTS, ...(await readAgentComponents(paths.composants)).valides];
  const page = await layOut({
    resultats: results,
    consigne: declaration.miseEnPage ?? null,
    catalogue,
    ia: o.ia,
    signal: o.signal,
    ...(o.delaiMiseEnPageMs !== undefined ? { delaiMs: o.delaiMiseEnPageMs } : {}),
  });
  const pendant = await lost();
  if (pendant) return pendant;
  // WebAiOs stops during the layout: the run is interrupted, with no result or memory. (The user's « Stop »,
  // on the other hand, keeps the result with the fallback layout.)
  if (o.interrompue?.() === true) {
    markInterrupted(execution);
    await keepRun();
    return (await lost()) ?? conclusion();
  }

  await keepRun();
  try {
    await writeResult(dossierActions, id, { version: 1, execution: execution.id, saisie: input, resultats: results, plan: page.plan, secours: page.secours, vide: page.vide });
    writtenResult = true;
  } catch (e) {
    // Too big (or disk): the run fails kernel-side, with no result.
    console.error(`[webaios] résultat de l'action ${id} :`, message(e));
    execution.statut = "echouee";
    execution.erreur = RESULT_TOO_BIG;
    execution.erreurNoyau = true;
    await keepRun();
    return (await lost()) ?? conclusion();
  }
  const afterResult = await lost();
  if (afterResult) return afterResult;

  if (!plan && issue.memoire) {
    // Re-read under the memory lock: a deletion that slipped in since does not leave it written (the erasure
    // of the action's data goes through this same lock).
    const kept = await withMemory(
      dataFolder,
      async () => (await accordRetire()) || !(await present()) || (await writeMemory(dataFolder, issue.memoire!)),
    );
    if (!kept) {
      execution.blocs.find((b) => b.id === valid.sortie.id)?.journal.push(MEMORY_NOT_KEPT);
      await keepRun();
    }
  }
  return (await lost()) ?? conclusion();
}

/** Removes the run and result written by this run only (same paths as `executions.ts` and `donnees.ts`). */
async function forgetThisRun(dataFolder: string, execution: string, written: { execution: boolean; resultat: boolean }): Promise<void> {
  if (!ID_EXECUTION.test(execution)) return;
  if (written.resultat) await rm(join(dataFolder, "resultats", `${execution}.json`), { force: true }).catch(() => {});
  if (written.execution) await rm(join(dataFolder, "executions", `${execution}.json`), { force: true }).catch(() => {});
}

/** The message of an action waiting for a new grant: the engine's if it stopped for that (profile denied…). */
function denialMessage(issue: IssueWorkflow, d: DeclarationAction): string {
  return issue.t === "arret" && issue.statut === "accord-requis" ? issue.erreur : actionGrantRequired(d);
}

