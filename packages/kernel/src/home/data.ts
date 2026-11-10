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
export async function readData(widgetsFolder: string, id: string): Promise<unknown | null> {
  const path = join(widgetsFolder, id, "data.json");
  try {
    if ((await stat(path)).size > DATA_MAX_SIZE) return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function writeData(widgetsFolder: string, id: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data ?? null);
  if (Buffer.byteLength(text) > DATA_MAX_SIZE) throw new Error("Données trop grosses (2 Mo au plus)");
  await writeAtomic(join(widgetsFolder, id, "data.json"), text);
}

/** Erases the harvested data, runs and block memory (for example when an account's grant is withdrawn). */
export async function deleteData(widgetsFolder: string, id: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`id de widget invalide : ${id}`);
  await rm(join(widgetsFolder, id, "data.json"), { force: true });
  await clearRunsAndMemory(join(widgetsFolder, id));
}

export async function readWidgetState(widgetsFolder: string, id: string): Promise<WidgetState> {
  try {
    return WidgetState.parse(JSON.parse(await readFile(join(widgetsFolder, id, "state.json"), "utf8")));
  } catch {
    // state.json absent or damaged: start again from the default state.
    return { ...DEFAULT_WIDGET_STATE };
  }
}

/** Per widget, the last write of its state: the next one waits for it (each re-reads what it keeps). */
const stateWrites = new Map<string, Promise<unknown>>();

function stateUnderLock<T>(widgetsFolder: string, id: string, f: () => Promise<T>): Promise<T> {
  const key = join(widgetsFolder, id);
  const task = (stateWrites.get(key) ?? Promise.resolve()).then(f);
  const end = task.catch(() => {});
  stateWrites.set(key, end);
  void end.then(() => {
    if (stateWrites.get(key) === end) stateWrites.delete(key);
  });
  return task;
}

async function writeStateWithoutLock(widgetsFolder: string, id: string, state: WidgetState): Promise<void> {
  // Hour tracking survives all state writes (running, error, grant, workshop stopped).
  const final = state.hours ? state : { ...state, ...(await currentHours(widgetsFolder, id)) };
  await writeAtomic(join(widgetsFolder, id, "state.json"), JSON.stringify(final, null, 2));
}

/** Writes of a widget's state go one after the other: none loses another's hour tracking. */
export function writeWidgetState(widgetsFolder: string, id: string, state: WidgetState): Promise<void> {
  return stateUnderLock(widgetsFolder, id, () => writeStateWithoutLock(widgetsFolder, id, state));
}

/**
 * Re-reads the widget's state and writes what `f` makes of it, with no other write of its state slipping in between
 * the two. `f` returns null: nothing is written. Returns the written state (or null).
 */
export function changeWidgetState(widgetsFolder: string, id: string, f: (state: WidgetState) => WidgetState | null): Promise<WidgetState | null> {
  return stateUnderLock(widgetsFolder, id, async () => {
    const state = f(await readWidgetState(widgetsFolder, id));
    if (state) await writeStateWithoutLock(widgetsFolder, id, state);
    return state;
  });
}

async function currentHours(widgetsFolder: string, id: string): Promise<Pick<WidgetState, "hours">> {
  const { hours: hours } = await readWidgetState(widgetsFolder, id);
  return hours ? { hours: hours } : {};
}
