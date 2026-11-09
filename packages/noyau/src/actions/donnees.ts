import { lstat, readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SpacePaths } from "../chemins.js";
import { DATA_MAX_SIZE } from "../workflows/protocole.js";
import { writeAtomic, ID_EXECUTION, listerExecutions } from "../workflows/executions.js";
import { withMemory, clearRunsAndMemory } from "../workflows/memoire.js";
import { retirerAccord } from "../widgets/accords.js";
import { PlanPage } from "../pages/plan.js";
import { ID_ACTION } from "./schemas.js";

/** What an action run returned: its results, the layout chosen for them and how it was chosen. */
export type ActionResult = {
  version: 1;
  execution: string;
  saisie: string | null;
  resultats: unknown;
  plan: PlanPage | null;
  secours: boolean;
  vide: boolean;
};

/** Margin beyond the workflow's data: the plan, the input and the envelope. */
export const RESULT_MARGIN_BYTES = 256 * 1024;
export const RESULT_MAX_BYTES = DATA_MAX_SIZE + RESULT_MARGIN_BYTES;

const ResultFile = z.object({
  version: z.literal(1),
  execution: z.string(),
  saisie: z.string().nullable(),
  resultats: z.unknown(),
  plan: PlanPage.nullable(),
  secours: z.boolean(),
  vide: z.boolean(),
});

const resultsFolder = (dataFolder: string) => join(dataFolder, "resultats");

/**
 * `<actionsFolder>/<id>/resultats/<run>.json`, written after the run of the same id. Keeps only the results
 * of runs that are kept (trials included). Too big: nothing is written and the call fails.
 */
export async function writeResult(dossierActions: string, id: string, r: ActionResult): Promise<void> {
  if (!ID_ACTION.test(id)) throw new Error(`id d'action invalide : ${id}`);
  if (!ID_EXECUTION.test(r.execution)) throw new Error(`id d'exécution invalide : ${r.execution}`);
  const text = JSON.stringify(r);
  if (Buffer.byteLength(text) > RESULT_MAX_BYTES) throw new Error("résultat trop gros");
  const dataFolder = join(dossierActions, id);
  const dossier = resultsFolder(dataFolder);
  await writeAtomic(join(dossier, `${r.execution}.json`), text);
  const kept = new Set((await listerExecutions(dataFolder)).map((e) => e.id));
  kept.add(r.execution);
  let names: string[] = [];
  try {
    names = await readdir(dossier);
  } catch {
    // folder gone in the meantime
  }
  for (const name of names) {
    if (name.endsWith(".json") && !kept.has(name.slice(0, -5))) await rm(join(dossier, name), { force: true });
  }
}

export async function readResult(dossierActions: string, id: string, execution: string): Promise<ActionResult | null> {
  if (!ID_ACTION.test(id) || !ID_EXECUTION.test(execution)) return null;
  try {
    const path = join(resultsFolder(join(dossierActions, id)), `${execution}.json`);
    if ((await stat(path)).size > RESULT_MAX_BYTES) return null;
    return ResultFile.parse(JSON.parse(await readFile(path, "utf8"))) satisfies ActionResult;
  } catch {
    return null;
  }
}

/** The result of the most recent real run (not a trial) that has one. */
export async function lastResult(dossierActions: string, id: string): Promise<ActionResult | null> {
  if (!ID_ACTION.test(id)) return null;
  for (const e of await listerExecutions(join(dossierActions, id))) {
    if (e.essai || e.id.endsWith("-essai")) continue;
    const r = await readResult(dossierActions, id, e.id);
    if (r) return r;
  }
  return null;
}

/** Erases runs, results and memory of an action (grant withdrawn, action deleted). */
export async function deleteDataAction(dossierActions: string, id: string): Promise<void> {
  if (!ID_ACTION.test(id)) throw new Error(`id d'action invalide : ${id}`);
  const dossier = join(dossierActions, id);
  await withMemory(dossier, async () => {
    await clearRunsAndMemory(dossier);
    await rm(resultsFolder(dossier), { recursive: true, force: true });
  });
  // The action's folder goes if empty; what WebAiOs did not put there stays.
  await rmdir(dossier).catch(() => {});
}

/**
 * At startup: for each `<actionsFolder>/<id>` without `~/WebAiOs/actions/<id>` (action deleted or put in the
 * trash), data and grant are erased. Actions still there, and what is not an action folder, stay.
 */
export async function forgetGoneActions(c: SpacePaths, dossierActions: string): Promise<void> {
  let entrees;
  try {
    // Actions folder not found (workspace moved, volume unmounted): nothing is known, nothing is erased.
    if (!(await stat(c.actions)).isDirectory()) return;
    await readdir(c.actions);
    entrees = await readdir(dossierActions, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entrees) {
    if (!e.isDirectory() || !ID_ACTION.test(e.name)) continue;
    const present = await lstat(join(c.actions, e.name)).then((s) => s.isDirectory(), () => false);
    if (present) continue;
    await deleteDataAction(dossierActions, e.name);
    await retirerAccord(dossierActions, e.name);
  }
}
