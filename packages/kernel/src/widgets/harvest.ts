import { join } from "node:path";
import { writeData, writeWidgetState, readData, readWidgetState, changeWidgetState, deleteData } from "../home/data.js";
import type { DeclarationWidget, WidgetState, WidgetLu } from "../home/schemas.js";
import type { Workshop } from "../container/workshop.js";
import type { LocalAi } from "../ai/local-ai.js";
import type { BrowserBridge } from "../mcp/bridge.js";
import { grantValid, readGrants, removeGrant } from "./grants.js";
import { message, truncate } from "../workflows/access.js";
import {
  MAX_ERROR,
  LOG_MAX,
  MEMORY_NOT_KEPT,
  PROFILE_DENIED,
  runDelays,
  runWorkflow,
  type WorkflowContext,
  type WorkflowOutcome,
  type ProcessLauncher,
  type Publication,
  type DirectTrace,
} from "../workflows/run.js";
import { writeRun, attemptId, idExecution, readRun, listRuns, type Execution, type BlockTrace } from "../workflows/executions.js";
import { readWorkflow } from "../workflows/read.js";
import type { Pacing } from "../workflows/pacing.js";
import { withMemory, writeMemory, readMemory, type BlocksMemory } from "../workflows/memory.js";
import { countNew } from "./nouveautes.js";
import { startTooBig } from "../workflows/protocole.js";
import { REPLAY_DEPTH, REPLAY_TOO_BIG, replayPlan } from "../workflows/replay.js";
import { INVALID_WORKFLOW_PREFIX, type Owner } from "../workflows/schema.js";
import type { ValidationContext, ValidWorkflow } from "../workflows/validate.js";

// Moved into the workflow engine; re-exported for the modules and tests that take them here.
export { localUrl } from "../workflows/access.js";
export { PROFILE_DENIED, defaultLaunch, type ProcessLauncher, type HarvestProcess } from "../workflows/run.js";

export interface HarvestOptions {
  id: string;
  widget: WidgetLu;
  dossierWidgets: string;
  /** Folder of the workflow engine on the Mac (`docker/moteur`), mounted read-only in the container. */
  moteur: string;
  atelier: Pick<Workshop, "commandeRecolte" | "supprimerRecolte">;
  lancer?: ProcessLauncher;
  /** null: no local AI, `kev` and `gemma` answer with an error. */
  ia: Pick<LocalAi, "kev" | "gemma"> | null;
  pont: BrowserBridge;
  horloge?: () => Date;
  /** Kernel-side timeout; the container stops by itself after 180 s (+5 s). */
  delaiMs?: number;
  /** Called after each write of the widget's state or data (refresh the display). */
  surChange?: () => void;
  /** Tests only: allows `recuperer` and `lirePage` to local addresses (127.0.0.1…). */
  adressesLocales?: boolean;
  /** What launched the run (default: the schedule). */
  declencheur?: Execution["declencheur"];
  /** True when the kernel is stopping: a run that did not finish is then « interrompue », not « échouée ». */
  interrompue?: () => boolean;
  /** Each accepted trace, live (the builder follows the blocks); must return control right away. */
  surTrace?: (t: DirectTrace) => void;
  /** Pacing of the searches and open reads, shared by all the kernel's runs. */
  menagement?: Pacing;
  /** Tests only: the base of the DuckDuckGo searches. */
  urlRecherche?: string;
}

/**
 * Outcome of a builder try: `ok` as soon as it ran (even failing, its run says so); otherwise, the reason
 * for the refusal (nothing was written, no container launched or nothing kept from it).
 */
export type AttemptResult = { ok: true; execution: string; statut: Execution["statut"] } | { ok: false; erreur: string };

/**
 * `execution`: the id of the written run (none when nothing ran, or when the grant was withdrawn meanwhile).
 * `nouveaux`: only for a finishing run of a `recolte.notifier` widget, the number of items that were
 * not in the data from before the run.
 */
export type HarvestResult = { etat: WidgetState; donnees?: unknown; execution?: string; nouveaux?: number };

const ID = /^[a-z0-9-]+$/;

export const grantRequired = (d: DeclarationWidget) => `Accord requis pour lire avec ton compte : ${d.sources.compte.join(", ")}`;
export const WORKSHOP_STOPPED_ERROR = "Mise à jour impossible : atelier arrêté";
export const INTERNAL_HARVEST_ERROR = "Mise à jour impossible : erreur interne du navigateur";
export const NO_WORKFLOW_ERROR = "Ce widget n'a ni workflow.json ni recolte.mjs";
export const INTERRUPTED_ERROR = "Interrompue : WebAiOs s'est arrêté";

/** Fixed error messages written by the kernel; any other error text may have been written by the widget. */
const FIXED_ERRORS = new Set([
  "Délai dépassé",
  "Réponse trop grande",
  PROFILE_DENIED,
  WORKSHOP_STOPPED_ERROR,
  INTERNAL_HARVEST_ERROR,
  NO_WORKFLOW_ERROR,
  INTERRUPTED_ERROR,
  // Old message, still in states written before the workflows.
  "Ce widget n'a pas de recolte.mjs",
  "Données trop grosses (2 Mo au plus)",
]);
const escapeChar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ERROR_PATTERNS = [
  // The declared domains only have [a-z0-9.-]; the message may have been truncated (« … »).
  /^Accord requis pour lire avec ton compte : [a-z0-9., -]*…?$/,
  // Written by the validation of workflow.json (drafted by the agent), never by the container. A widget can throw the same
  // text: it is then `erreurNoyau` (absent) that says so.
  new RegExp(`^${escapeChar(INVALID_WORKFLOW_PREFIX)}`),
];

/**
 * Does the error come from the kernel, without anything the widget could have written? For a widget that reads with the user's account,
 * only such an error (and marked `erreurNoyau` in the state) is shown to the agent without a grant.
 */
export function kernelError(error: string): boolean {
  return FIXED_ERRORS.has(error) || ERROR_PATTERNS.some((m) => m.test(error));
}

/** A widget's workflow: `workflow.json`, or `recolte.mjs` alone (implicit workflow). */
type WidgetWorkflow =
  | { t: "ok"; valide: ValidWorkflow; declaration: DeclarationWidget }
  /** The widget is unreadable: its error may quote its files. */
  | { t: "illisible"; erreur: string }
  | { t: "absent" }
  /** workflow.json half-written, unknown block, cycle… (validator message, truncated). */
  | { t: "invalide"; erreur: string };

/** What the widget's declaration changes to the rules of its workflow. */
export function validationContext(d: DeclarationWidget): ValidationContext {
  return { web: d.sources.web, dureeMaxMinutes: d.recolte?.dureeMaxMinutes ?? null, proprietaire: "widget", saisie: false };
}

async function widgetWorkflow(widget: WidgetLu): Promise<WidgetWorkflow> {
  if ("erreur" in widget) return { t: "illisible", erreur: widget.erreur };
  const lu = await readWorkflow(widget.dossier, validationContext(widget.declaration));
  if (!lu) return { t: "absent" };
  if (!lu.resultat.ok) return { t: "invalide", erreur: truncate(lu.resultat.erreur, MAX_ERROR) };
  return { t: "ok", valide: lu.resultat.valide, declaration: widget.declaration };
}

/**
 * A grant that no longer holds for the current declaration (domains changed, account removed) is withdrawn, and what was
 * read with it erased (data, runs, memory): nothing passes to the next harvest nor, later, to the agent.
 * `peut`: the widget may run (without account, or with a valid grant, which also covers its public domains);
 * `retire`: an expired grant has just been withdrawn.
 */
async function validGrant(widgetsFolder: string, id: string, declaration: DeclarationWidget): Promise<{ peut: boolean; retire: boolean }> {
  const grantSaved = (await readGrants(widgetsFolder))[id];
  const removed = grantSaved !== undefined && !grantValid(declaration, grantSaved);
  if (removed) {
    await removeGrant(widgetsFolder, id);
    await deleteData(widgetsFolder, id);
  }
  const can = declaration.sources.compte.length === 0 || grantValid(declaration, (await readGrants(widgetsFolder))[id]);
  return { peut: can, retire: removed };
}

/**
 * The grant has just been lost outside a harvest (during a try): like `refuserAccord`, the widget goes into waiting
 * for a grant (dates kept) and the display is notified. Already waiting for a grant: nothing is rewritten.
 */
async function markGrantRequired(o: HarvestOptions, error: string): Promise<void> {
  const before = await readWidgetState(o.dossierWidgets, o.id);
  if (before.statut === "accord-requis") return;
  await writeWidgetState(o.dossierWidgets, o.id, {
    statut: "accord-requis",
    derniereMaj: before.derniereMaj,
    derniereTentative: before.derniereTentative,
    erreur: truncate(error, MAX_ERROR),
    erreurNoyau: true,
  });
  o.surChange?.();
}

/** What a widget's run asks about its grant (re-read at each read with an account). */
function grantContext(
  widgetsFolder: string,
  id: string,
  declaration: DeclarationWidget,
): Pick<WorkflowContext, "accord" | "surProfilRefuse" | "messageAccordRequis" | "sources"> {
  return {
    sources: declaration.sources,
    async accord() {
      const a = (await readGrants(widgetsFolder))[id];
      return grantValid(declaration, a) ? { profil: a.profil } : null;
    },
    // The grant is withdrawn before the stop: when the run concludes, it no longer exists. What was read with this account goes
    // with it (the widget shows its example until the new grant).
    async surProfilRefuse() {
      await removeGrant(widgetsFolder, id);
      await deleteData(widgetsFolder, id);
    },
    messageAccordRequis: grantRequired(declaration),
  };
}

/** Has the grant been withdrawn (refuserAccord erases everything)? Always false for a widget without an account. */
async function removedGrantOf(widgetsFolder: string, id: string, declaration: DeclarationWidget): Promise<boolean> {
  return declaration.sources.compte.length > 0 && !grantValid(declaration, (await readGrants(widgetsFolder))[id]);
}

/** What the infrastructure receives from the options of a harvest or a try. */
function infraOf(o: HarvestOptions, clock: () => Date): Parameters<typeof runWorkflow>[1] {
  return {
    moteur: o.moteur,
    atelier: o.atelier,
    ...(o.lancer ? { lancer: o.lancer } : {}),
    ia: o.ia,
    pont: o.pont,
    horloge: clock,
    ...(o.delaiMs !== undefined ? { delaiMs: o.delaiMs } : {}),
    ...(o.adressesLocales ? { adressesLocales: true } : {}),
    ...(o.surTrace ? { surTrace: o.surTrace } : {}),
    ...(o.menagement ? { menagement: o.menagement } : {}),
    ...(o.urlRecherche !== undefined ? { urlRecherche: o.urlRecherche } : {}),
  };
}

/** Kernel stop: the run did not fail, it is interrupted; a block started without an end is interrupted. */
export function markInterrupted(execution: Execution): void {
  execution.statut = "interrompue";
  execution.erreur = INTERRUPTED_ERROR;
  execution.erreurNoyau = true;
  execution.blocs = execution.blocs.map((b) => (b.debut !== null && b.fin === null ? { ...b, statut: "interrompu" } : b));
}

/** Status and error from before a run (those from before the previous one, if it did not finish itself). */
function stateBeforeRun(e: WidgetState): NonNullable<WidgetState["avant"]> {
  if (e.statut === "en-cours") return e.avant ?? { statut: "ok" };
  return { statut: e.statut, ...(e.erreur !== undefined ? { erreur: e.erreur } : {}), ...(e.erreurNoyau ? { erreurNoyau: true as const } : {}) };
}

/**
 * A widget's harvest: the run of its workflow (`workflow.json`, or `recolte.mjs` alone, as an implicit workflow)
 * by the engine, which writes nothing. Here, what is kept: `etat.json` (en-cours at the start), and depending on the outcome
 * `donnees.json`, `memoire.json` and the run. For a widget with an account, the grant is re-read after each write:
 * withdrawn, everything read with it goes (data, runs, memory) and the widget waits for a new grant.
 */
export async function runHarvest(o: HarvestOptions): Promise<HarvestResult> {
  const { id, widget, dossierWidgets: widgetsFolder } = o;
  if (!ID.test(id) || widget.id !== id) throw new Error(`id de widget invalide : ${id}`);
  const clock = o.horloge ?? (() => new Date());
  const dataFolder = join(widgetsFolder, id);
  const owner: Owner = { type: "widget", id };
  const trigger = o.declencheur ?? "planifiee";
  const previous = await readWidgetState(widgetsFolder, id);
  const start = clock().toISOString();
  // The previous state, kept during the run: restored at the next startup if WebAiOs stops abruptly.
  const before = stateBeforeRun(previous);
  await writeWidgetState(widgetsFolder, id, { statut: "en-cours", derniereMaj: previous.derniereMaj, derniereTentative: start, avant: before });
  o.surChange?.();

  /** `erreurWidget`: the error text comes from the widget or the container (otherwise, it is written by the kernel). */
  const conclude = async (r: {
    statut: WidgetState["statut"];
    erreur?: string;
    erreurWidget?: boolean;
    journal?: string;
    donnees?: unknown;
    execution?: string;
  }): Promise<HarvestResult> => {
    const state: WidgetState = {
      statut: r.statut,
      derniereMaj: r.statut === "ok" ? clock().toISOString() : previous.derniereMaj,
      derniereTentative: start,
    };
    if (r.erreur) {
      state.erreur = truncate(r.erreur, MAX_ERROR);
      if (!r.erreurWidget) state.erreurNoyau = true;
    }
    if (r.journal) state.journal = r.journal;
    await writeWidgetState(widgetsFolder, id, state);
    o.surChange?.();
    return {
      etat: state,
      ...(r.statut === "ok" ? { donnees: r.donnees } : {}),
      ...(r.execution ? { execution: r.execution } : {}),
    };
  };
  /** A run that the kernel stopped before any container: its blocks are not launched. */
  const withoutContainer = async (status: Execution["statut"], error: string, blocks: BlockTrace[]): Promise<string> => {
    const e: Execution = {
      version: 1,
      id: idExecution(start),
      proprietaire: owner,
      declencheur: trigger,
      debut: start,
      fin: clock().toISOString(),
      statut: status,
      erreur: error,
      erreurNoyau: true,
      blocs: blocks,
    };
    await writeRun(dataFolder, e);
    return e.id;
  };

  const lu = await widgetWorkflow(widget);
  // The widget's read error may quote its files: it counts as written by the widget.
  if (lu.t === "illisible") return conclude({ statut: "erreur", erreur: lu.erreur, erreurWidget: true });
  if (lu.t === "absent") return conclude({ statut: "erreur", erreur: NO_WORKFLOW_ERROR });
  // workflow.json half-written, unknown block, cycle…: no container is launched, the data stays.
  if (lu.t === "invalide") return conclude({ statut: "erreur", erreur: lu.erreur, execution: await withoutContainer("echouee", lu.erreur, []) });
  const { valide: valid, declaration } = lu;
  // A widget that reads with the user's account only runs with their grant (an expired grant is withdrawn, with its data).
  if (!(await validGrant(widgetsFolder, id, declaration)).peut) {
    const error = grantRequired(declaration);
    // Already waiting for a grant at the last run: not one more at each scheduling (they would push
    // the history of the real runs out), the last one stands in. Tries do not count.
    const last = (await listRuns(dataFolder)).find((e) => !e.essai);
    if (last?.statut === "accord-requis") return conclude({ statut: "accord-requis", erreur: error, execution: last.id });
    const notRun: BlockTrace[] = valid.ordre.map((b) => ({
      id: b,
      type: valid.workflow.blocs.find((x) => x.id === b)!.type,
      statut: "pas-lance",
      debut: null,
      fin: null,
      elements: null,
      journal: [],
    }));
    return conclude({ statut: "accord-requis", erreur: error, execution: await withoutContainer("accord-requis", error, notRun) });
  }

  // The grant may have been withdrawn during the run (refuserAccord erases everything), or during a write from here (it may have
  // come after the erasure): nothing read with it remains, not even the run.
  const removedGrant = () => removedGrantOf(widgetsFolder, id, declaration);
  /** A run's memory, under the widget's memory lock, if the grant holds; false if too big. */
  const keepMemory = (m: BlocksMemory) =>
    withMemory(dataFolder, async () => (await removedGrant()) || (await writeMemory(dataFolder, m)));

  // Progressive run (the engine relays nothing to the others): each accepted publication is written right away,
  // with the progress in the state; the safe memory received along the way too. The engine does these relays one
  // after the other and waits for all of them before returning: the final output, written afterwards, is never overwritten.
  // Grant withdrawn (widget with an account): what was published goes, and nothing more is written along the way.
  const dataBefore = await readData(widgetsFolder, id);
  let closedRelays = false;
  const closeIfGrantRemoved = async (): Promise<boolean> => {
    if (!(await removedGrant())) return false;
    closedRelays = true;
    await deleteData(widgetsFolder, id);
    return true;
  };
  const onPublish = async (p: Publication) => {
    if (closedRelays) return;
    await writeData(widgetsFolder, id, p.donnees);
    if (await closeIfGrantRemoved()) return;
    const progression = { faits: p.faits, total: p.total };
    // Only on top of this run's en-cours: an accord-requis written in the meantime (refuserAccord) stays.
    await changeWidgetState(widgetsFolder, id, (e) =>
      e.statut === "en-cours" ? { statut: "en-cours", derniereMaj: previous.derniereMaj, derniereTentative: start, progression, avant: before } : null,
    );
    if (await closeIfGrantRemoved()) return;
    o.surChange?.();
  };
  const onMemory = async (m: BlocksMemory) => {
    if (closedRelays) return;
    await keepMemory(m);
  };

  const maxDurationMinutes = declaration.recolte?.dureeMaxMinutes;
  const { issue: outcome, execution, journal: runLog } = await runWorkflow(
    {
      proprietaire: owner,
      valide: valid,
      dossierFichiers: widget.dossier,
      config: declaration.config ?? null,
      precedent: dataBefore,
      memoire: await readMemory(dataFolder),
      ...grantContext(widgetsFolder, id, declaration),
      declencheur: trigger,
      ...(maxDurationMinutes !== undefined ? { dureeMaxMinutes: maxDurationMinutes } : {}),
    },
    { ...infraOf(o, clock), surPublication: onPublish, surMemoire: onMemory },
  );
  // The relays are all finished (the engine waits for them): nothing more is written along the way.
  closedRelays = true;
  let log = runLog;

  const denied = async () => {
    await deleteData(widgetsFolder, id);
    return conclude({ statut: "accord-requis", erreur: denialMessage(outcome, declaration) });
  };
  /**
   * Failure or stop: the run is written; the data (previous, or published along the way) stays. The
   * previous memory stays, except for a progressive run that returns its last safe memory (`memoire`).
   */
  const concludeWithoutData = async (e: Execution, r: Parameters<typeof conclude>[0], memory?: BlocksMemory | null): Promise<HarvestResult> => {
    await writeRun(dataFolder, e);
    if (await removedGrant()) return denied();
    if (memory) {
      await keepMemory(memory);
      if (await removedGrant()) return denied();
    }
    const finished = await conclude({ ...r, execution: e.id });
    if (await removedGrant()) return denied();
    return finished;
  };
  if (await removedGrant()) return denied();

  if (outcome.t === "fin") {
    try {
      if (outcome.sortie.vers === "widget") await writeData(widgetsFolder, id, outcome.sortie.valeur);
    } catch (e) {
      // Data refused (too big…): the previous ones stay, the run fails kernel-side.
      execution.statut = "echouee";
      execution.erreur = truncate(message(e), MAX_ERROR);
      execution.erreurNoyau = true;
      return concludeWithoutData(execution, { statut: "erreur", erreur: execution.erreur, journal: log });
    }
    if (await removedGrant()) return denied();
    if (outcome.memoire) {
      if (!(await keepMemory(outcome.memoire))) {
        log = add(log, MEMORY_NOT_KEPT);
        // Also in the run, in the output block's log.
        execution.blocs.find((b) => b.id === valid.sortie.id)?.journal.push(MEMORY_NOT_KEPT);
      }
      if (await removedGrant()) return denied();
    }
    await writeRun(dataFolder, execution);
    if (await removedGrant()) return denied();
    const ok = await conclude({ statut: "ok", donnees: outcome.sortie.valeur, journal: log, execution: execution.id });
    // Withdrawn during the state write: « ok » must not overwrite the accord-requis written by refuserAccord.
    if (await removedGrant()) return denied();
    // Counted against the data from before the run (those published along the way are not in it).
    if (declaration.recolte?.notifier === true) return { ...ok, nouveaux: countNew(dataBefore, outcome.sortie.valeur) };
    return ok;
  }

  // Kernel stop (exit, profile change): the run did not fail, it is interrupted.
  // Its error is the kernel's (not the irrelevant one of the killed container); a block started without an end is interrupted.
  const interrupted = o.interrompue?.() === true && execution.statut !== "accord-requis";
  if (interrupted) markInterrupted(execution);
  // Progressive run: its last safe memory is kept (never when it stops for lack of a grant).
  const memory = outcome.t === "arret" && outcome.statut === "accord-requis" ? null : outcome.memoire;
  return outcome.t === "arret"
    ? concludeWithoutData(execution, { statut: outcome.statut, erreur: outcome.erreur, journal: log }, memory)
    : // The provenance comes from the engine: `erreurNoyau` absent, the text may have been written by the widget's code.
      // Interrupted: the message is the kernel's, not the text the widget's code may have written.
      concludeWithoutData(
        execution,
        interrupted
          ? { statut: "erreur", erreur: INTERRUPTED_ERROR, journal: log }
          : { statut: "erreur", erreur: outcome.erreur, erreurWidget: !execution.erreurNoyau, journal: log },
        memory,
      );
}

/**
 * A builder try: replays the widget's workflow from block `depart`, taking from run
 * `origine` the output of the upstream blocks. What the try produces never touches `etat.json`, `donnees.json` nor
 * `memoire.json`: only the `-essai` run is kept (a failed try shows no error on the home). Like
 * a harvest, a widget with an account only runs with the user's grant. Only exception: a grant lost because of
 * the try (expired at the start, profile refused, withdrawn meanwhile) follows the normal withdrawal path — everything read with it
 * goes, try included, and the widget goes to `accord-requis`.
 */
export async function runAttempt(o: HarvestOptions & { origine: string; depart: string }): Promise<AttemptResult> {
  const { id, widget, dossierWidgets: widgetsFolder } = o;
  if (!ID.test(id) || widget.id !== id) throw new Error(`id de widget invalide : ${id}`);
  const clock = o.horloge ?? (() => new Date());
  const dataFolder = join(widgetsFolder, id);
  const denial = (error: string): AttemptResult => ({ ok: false, erreur: error });

  const lu = await widgetWorkflow(widget);
  if (lu.t === "absent") return denial(NO_WORKFLOW_ERROR);
  if (lu.t !== "ok") return denial(lu.erreur);
  const { valide: valid, declaration } = lu;
  const grant = await validGrant(widgetsFolder, id, declaration);
  if (!grant.peut) {
    // Expired grant withdrawn: the widget waits for a new grant. Never given: nothing is written.
    if (grant.retire) await markGrantRequired(o, grantRequired(declaration));
    return denial(grantRequired(declaration));
  }

  const [origin, earlier] = await originChain(dataFolder, o.origine);
  const plan = replayPlan(valid, origin, o.depart, earlier);
  if (!plan.ok) return denial(plan.erreur);
  const previous = await readData(widgetsFolder, id);
  const config = declaration.config ?? null;
  const workflow = { blocs: valid.workflow.blocs, liens: valid.workflow.liens, ordre: valid.ordre };
  const replay = { relances: plan.relances, sorties: plan.sorties };
  // A try has the delays of the widget's maximum duration (a watch must be tryable), without ever being progressive.
  const maxDurationMinutes = declaration.recolte?.dureeMaxMinutes;
  const { limiteMs: limitMs } = runDelays(maxDurationMinutes);
  // Measured before any container, on the line as it will go out: the harvester would refuse it, and nothing must be written.
  const now = clock().toISOString();
  if (startTooBig({ precedent: previous, maintenant: now, config, workflow, rejeu: replay, ...(limitMs !== undefined ? { limiteMs: limitMs } : {}) })) {
    return denial(REPLAY_TOO_BIG);
  }

  const { issue: outcome, execution } = await runWorkflow(
    {
      proprietaire: { type: "widget", id },
      valide: valid,
      dossierFichiers: widget.dossier,
      config,
      precedent: previous,
      // A try neither receives nor keeps any memory.
      memoire: {},
      ...grantContext(widgetsFolder, id, declaration),
      declencheur: "rejeu",
      rejeu: { ...replay, repris: plan.repris },
      ...(maxDurationMinutes !== undefined ? { dureeMaxMinutes: maxDurationMinutes } : {}),
    },
    infraOf(o, clock),
  );
  // The executor's safety net (the measure here must have refused before): a refusal, nothing written.
  if (outcome.t === "arret" && outcome.erreur === REPLAY_TOO_BIG) return denial(REPLAY_TOO_BIG);

  // The grant may have been withdrawn during the try, or during its write: nothing read with it remains.
  const removed = async () => {
    if (!(await removedGrantOf(widgetsFolder, id, declaration))) return null;
    await deleteData(widgetsFolder, id);
    const error = denialMessage(outcome, declaration);
    await markGrantRequired(o, error);
    return denial(error);
  };
  const before = await removed();
  if (before) return before;

  execution.id = attemptId(execution.debut);
  execution.essai = { depart: o.depart, origine: plan.origine };
  if (outcome.t !== "fin" && o.interrompue?.() === true && execution.statut !== "accord-requis") markInterrupted(execution);
  await writeRun(dataFolder, execution);
  const after = await removed();
  if (after) return after;
  return { ok: true, execution: execution.id, statut: execution.statut };
}

/**
 * The original run of a try and, when it is itself a try, the chain of its origins (bounded): their
 * `repris` blocks find their output there. A pruned origin stops the chain.
 */
export async function originChain(dataFolder: string, id: string): Promise<[Execution | null, Execution[]]> {
  const origin = await readRun(dataFolder, id);
  const earlier: Execution[] = [];
  const seen = new Set([id]);
  let e = origin;
  while (e?.essai && earlier.length < REPLAY_DEPTH - 1 && !seen.has(e.essai.origine)) {
    seen.add(e.essai.origine);
    e = await readRun(dataFolder, e.essai.origine);
    if (e) earlier.push(e);
  }
  return [origin, earlier];
}

/** The message of a widget waiting for a new grant: the engine's if it stopped for that (profile refused…). */
function denialMessage(outcome: WorkflowOutcome, declaration: DeclarationWidget): string {
  return outcome.t === "arret" && outcome.statut === "accord-requis" ? outcome.erreur : grantRequired(declaration);
}

function add(log: string, line: string): string {
  return ((log ? log + "\n" : "") + line).slice(-LOG_MAX);
}
