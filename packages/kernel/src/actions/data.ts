import { lstat, readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SpacePaths } from "../paths.js";
import { DATA_MAX_SIZE } from "../workflows/protocole.js";
import { writeAtomic, ID_EXECUTION, listRuns } from "../workflows/executions.js";
import { withMemory, clearRunsAndMemory } from "../workflows/memory.js";
import { removeGrant } from "../widgets/grants.js";
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
export async function writeResult(actionsFolder: string, id: string, r: ActionResult): Promise<void> {
  if (!ID_ACTION.test(id)) throw new Error(`id d'action invalide : ${id}`);
  if (!ID_EXECUTION.test(r.execution)) throw new Error(`id d'exécution invalide : ${r.execution}`);
  const text = JSON.stringify(r);
  if (Buffer.byteLength(text) > RESULT_MAX_BYTES) throw new Error("résultat trop gros");
  const dataFolder = join(actionsFolder, id);
  const folder = resultsFolder(dataFolder);
  await writeAtomic(join(folder, `${r.execution}.json`), text);
  const kept = new Set((await listRuns(dataFolder)).map((e) => e.id));
  kept.add(r.execution);
  let names: string[] = [];
  try {
    names = await readdir(folder);
  } catch {
    // folder gone in the meantime
  }
  for (const name of names) {
    if (name.endsWith(".json") && !kept.has(name.slice(0, -5))) await rm(join(folder, name), { force: true });
  }
}

export async function readResult(actionsFolder: string, id: string, execution: string): Promise<ActionResult | null> {
  if (!ID_ACTION.test(id) || !ID_EXECUTION.test(execution)) return null;
  try {
    const path = join(resultsFolder(join(actionsFolder, id)), `${execution}.json`);
    if ((await stat(path)).size > RESULT_MAX_BYTES) return null;
    return ResultFile.parse(JSON.parse(await readFile(path, "utf8"))) satisfies ActionResult;
  } catch {
    return null;
  }
}

/** The result of the most recent real run (not a trial) that has one. */
export async function lastResult(actionsFolder: string, id: string): Promise<ActionResult | null> {
  if (!ID_ACTION.test(id)) return null;
  for (const e of await listRuns(join(actionsFolder, id))) {
    if (e.essai || e.id.endsWith("-essai")) continue;
    const r = await readResult(actionsFolder, id, e.id);
    if (r) return r;
  }
  return null;
}

/** Erases runs, results and memory of an action (grant withdrawn, action deleted). */
export async function deleteDataAction(actionsFolder: string, id: string): Promise<void> {
  if (!ID_ACTION.test(id)) throw new Error(`id d'action invalide : ${id}`);
  const folder = join(actionsFolder, id);
  await withMemory(folder, async () => {
    await clearRunsAndMemory(folder);
    await rm(resultsFolder(folder), { recursive: true, force: true });
  });
  // The action's folder goes if empty; what WebAiOs did not put there stays.
  await rmdir(folder).catch(() => {});
}

/**
 * At startup: for each `<actionsFolder>/<id>` without `~/WebAiOs/actions/<id>` (action deleted or put in the
 * trash), data and grant are erased. Actions still there, and what is not an action folder, stay.
 */
export async function forgetGoneActions(c: SpacePaths, actionsFolder: string): Promise<void> {
  let entries;
  try {
    // Actions folder not found (workspace moved, volume unmounted): nothing is known, nothing is erased.
    if (!(await stat(c.actions)).isDirectory()) return;
    await readdir(c.actions);
    entries = await readdir(actionsFolder, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !ID_ACTION.test(e.name)) continue;
    const present = await lstat(join(c.actions, e.name)).then((s) => s.isDirectory(), () => false);
    if (present) continue;
    await deleteDataAction(actionsFolder, e.name);
    await removeGrant(actionsFolder, e.name);
  }
}
