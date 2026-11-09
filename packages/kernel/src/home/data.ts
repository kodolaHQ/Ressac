import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearRunsAndMemory } from "../workflows/memory.js";
import { DEFAULT_WIDGET_STATE, WidgetState, DATA_MAX_SIZE } from "./schemas.js";

// A temporary name specific to each write: two simultaneous writes (a grant denied during a harvest)
// do not trample each other.
async function writeAtomic(target: string, text: string): Promise<void> {
  await mkdir(join(target, ".."), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

/** Harvested data of a widget, or null if absent, damaged or too big (over 2 MB). */
export async function readData(dossierWidgets: string, id: string): Promise<unknown | null> {
  const path = join(dossierWidgets, id, "donnees.json");
  try {
    if ((await stat(path)).size > DATA_MAX_SIZE) return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function writeData(dossierWidgets: string, id: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data ?? null);
  if (Buffer.byteLength(text) > DATA_MAX_SIZE) throw new Error("Données trop grosses (2 Mo au plus)");
  await writeAtomic(join(dossierWidgets, id, "donnees.json"), text);
}

/** Erases the harvested data, runs and block memory (for example when an account's grant is withdrawn). */
export async function deleteData(dossierWidgets: string, id: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`id de widget invalide : ${id}`);
  await rm(join(dossierWidgets, id, "donnees.json"), { force: true });
  await clearRunsAndMemory(join(dossierWidgets, id));
}

export async function readWidgetState(dossierWidgets: string, id: string): Promise<WidgetState> {
  try {
    return WidgetState.parse(JSON.parse(await readFile(join(dossierWidgets, id, "etat.json"), "utf8")));
  } catch {
    // etat.json absent or damaged: start again from the default state.
    return { ...DEFAULT_WIDGET_STATE };
  }
}

/** Per widget, the last write of its state: the next one waits for it (each re-reads what it keeps). */
const stateWrites = new Map<string, Promise<unknown>>();

function stateUnderLock<T>(dossierWidgets: string, id: string, f: () => Promise<T>): Promise<T> {
  const key = join(dossierWidgets, id);
  const tache = (stateWrites.get(key) ?? Promise.resolve()).then(f);
  const fin = tache.catch(() => {});
  stateWrites.set(key, fin);
  void fin.then(() => {
    if (stateWrites.get(key) === fin) stateWrites.delete(key);
  });
  return tache;
}

async function writeStateWithoutLock(dossierWidgets: string, id: string, state: WidgetState): Promise<void> {
  // Hour tracking survives all state writes (running, error, grant, workshop stopped).
  const final = state.heures ? state : { ...state, ...(await currentHours(dossierWidgets, id)) };
  await writeAtomic(join(dossierWidgets, id, "etat.json"), JSON.stringify(final, null, 2));
}

/** Writes of a widget's state go one after the other: none loses another's hour tracking. */
export function writeWidgetState(dossierWidgets: string, id: string, state: WidgetState): Promise<void> {
  return stateUnderLock(dossierWidgets, id, () => writeStateWithoutLock(dossierWidgets, id, state));
}

/**
 * Re-reads the widget's state and writes what `f` makes of it, with no other write of its state slipping in between
 * the two. `f` returns null: nothing is written. Returns the written state (or null).
 */
export function changeWidgetState(dossierWidgets: string, id: string, f: (state: WidgetState) => WidgetState | null): Promise<WidgetState | null> {
  return stateUnderLock(dossierWidgets, id, async () => {
    const state = f(await readWidgetState(dossierWidgets, id));
    if (state) await writeStateWithoutLock(dossierWidgets, id, state);
    return state;
  });
}

async function currentHours(dossierWidgets: string, id: string): Promise<Pick<WidgetState, "heures">> {
  const { heures: hours } = await readWidgetState(dossierWidgets, id);
  return hours ? { heures: hours } : {};
}
