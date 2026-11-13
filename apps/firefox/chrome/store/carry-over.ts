import fs from "node:fs/promises";
import { firefoxProfiles, iniSections } from "./import/sources";

/**
 * The one-time carry-over from WebAiOs, Ressac's former name: on the first launch of Ressac on a machine that had
 * WebAiOs, its data folder (`~/WebAiOs`) and its Firefox profile become Ressac's. It moves, never copies nor deletes
 * (but three disposable caches), and stops before the first move when anything is doubtful. Plain `/` joins and
 * node:fs (shimmed onto IOUtils in the store bundle) keep it testable in Node.
 */

/** The old names: the data folder under the home folder, the Firefox profile root under Application Support. */
export const LEGACY = { dataDir: "WebAiOs", profileRoot: "WebAiOs" };
const NAME = "default-ressac";
const SOURCE = "carry-over";
/** Rebuilt at start under their new names. */
const CACHES = ["webaios-sites", "webaios-widgets", "webaios-components"];

/** The parts of nsIToolkitProfile used. */
export interface Profile {
  readonly rootDir: { path: string };
  readonly localDir: { path: string };
  /** Throws NS_ERROR_FILE_ACCESS_DENIED when another running instance holds the profile. */
  lock(unlocker: object): { unlock(): void };
  /** false: unregisters only, the files stay. */
  remove(removeFiles: boolean): void;
}
/** The parts of nsIToolkitProfileService used; `createProfile` takes a path (the caller makes the nsIFile). */
export interface ProfileService {
  readonly currentProfile: Profile | null;
  readonly isFirstRun: boolean;
  /** Returns the profile already registered under `name`, if any. */
  createProfile(rootDir: string, name: string, source: string): Profile;
  defaultProfile: Profile | null;
  flush(): void;
}
export interface Env {
  get(name: string): string;
  set(name: string, value: string): void;
}
interface Options {
  home: string;
  /** ~/Library/Application Support, as the system gives it (the profile roots' parent). */
  appSupport: string;
  profiles: ProfileService;
  env: Env;
}
interface State {
  state: "pending" | "done";
  /** pending: the old folder chosen; done: the adopted folder. */
  profile: string;
  /** The person was told once, after the carry-over. */
  told?: boolean;
}

const exists = (path: string) => fs.access(path).then(() => true, () => false);
const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stateFile = (o: Options) => `${o.appSupport}/Ressac/carried.json`;

async function readState(o: Options): Promise<State | null> {
  try {
    return JSON.parse(await fs.readFile(stateFile(o), "utf8"));
  } catch {
    return null;
  }
}

async function writeState(o: Options, s: State): Promise<void> {
  await fs.mkdir(`${o.appSupport}/Ressac`, { recursive: true });
  await fs.writeFile(stateFile(o), JSON.stringify(s));
}

/** A development or test launch: a profile given on the command line, or a test or dev data folder. */
const guarded = (o: Options) => !o.profiles.currentProfile || !!o.env.get("RESSAC_DATA_DIR") || !!o.env.get("RESSAC_TEST_NO_SYSTEM");

/** Without these the restart would reuse the running profile (xpcom/base/AppShutdown.cpp). */
function restart(o: Options, p: Profile): "restart" {
  o.env.set("XRE_PROFILE_PATH", p.rootDir.path);
  o.env.set("XRE_PROFILE_LOCAL_PATH", p.localDir.path);
  return "restart";
}

/**
 * Line 4: WebAiOs's profile. `id` is its folder in the old root, `at` where it is now: `movedTo(id)` when a previous
 * attempt already moved it (only looked at when `retry`).
 */
async function oldProfile(o: Options, root: string, movedTo: (id: string) => string, retry: boolean): Promise<{ id: string; at: string } | null> {
  const where = async (id: string) => ((await exists(id)) ? id : retry && (await exists(movedTo(id))) ? movedTo(id) : null);
  const read = (path: string) => fs.readFile(path, "utf8").catch(() => "");
  const found: { id: string; at: string; installed: boolean; used: number }[] = [];
  for (const { id } of firefoxProfiles(await read(`${root}/profiles.ini`), root)) {
    const at = await where(id);
    if (!at) continue;
    const platform = iniSections(await read(`${at}/compatibility.ini`)).find((s) => s[""] === "[Compatibility]")?.LastPlatformDir ?? "";
    if (!/(^|\/)WebAiOs\.app(\/|$)/.test(platform)) continue;
    // A build tree's WebAiOs.app (a developer's) may be the most recent: the installed app's profile is the one in use.
    const installed = ["/Applications", `${o.home}/Applications`].some((dir) => platform.startsWith(`${dir}/WebAiOs.app/`));
    // prefs.js is written as the browser runs and quits: the latest is the profile used last.
    const used = await fs.stat(`${at}/prefs.js`).then((s) => s.mtimeMs, () => 0);
    found.push({ id, at, installed, used });
  }
  found.sort((a, b) => Number(b.installed) - Number(a.installed) || b.used - a.used);
  if (found[0]) return found[0];
  for (const s of iniSections(await read(`${root}/installs.ini`))) {
    if (s.Locked !== "1" || !s.Default) continue;
    const id = s.Default.startsWith("/") ? s.Default : `${root}/${s.Default}`;
    const at = await where(id);
    if (at) return { id, at };
  }
  return null;
}

/**
 * Runs before anything creates the data folder. "restart": restart now, start nothing else. "blocked": WebAiOs is
 * running; "data-blocked": ~/WebAiOs could not be moved (say which, then quit: the state stays pending and the next
 * launch retries). "done": a normal start. Throws on a later failure (the data already moved: the next launch takes
 * the profile again).
 */
export async function carryOver(o: Options): Promise<"restart" | "blocked" | "data-blocked" | "done"> {
  // Line 1.
  if (guarded(o)) return "done";
  const state = await readState(o);
  // Line 2: the app moved to another path is a new install, given a new empty profile: back to the carried one.
  if (state?.state === "done") {
    if (!o.profiles.isFirstRun || !(await exists(state.profile))) return "done";
    const carried = o.profiles.createProfile(state.profile, NAME, SOURCE);
    if (carried.rootDir.path !== state.profile) return "done";
    o.profiles.defaultProfile = carried;
    o.profiles.flush();
    return restart(o, carried);
  }
  const root = `${o.appSupport}/${LEGACY.profileRoot}`;
  const oldData = `${o.home}/${LEGACY.dataDir}`;
  const newData = `${o.home}/Ressac`;
  // Line 3. Line 9: a pending state goes on from line 4.
  if (!state && (!(await exists(root)) || (await exists(newData)))) return "done";
  // Line 4.
  const movedTo = (id: string) => `${o.appSupport}/Ressac/Profiles/${leaf(id)}`;
  const chosen = await oldProfile(o, root, movedTo, !!state);
  if (!chosen) return "done";
  const target = movedTo(chosen.id);
  // Another folder of that name already there: never moved into (IOUtils.move would put it inside).
  if (chosen.at !== target && (await exists(target))) return "done";
  // Line 5: WebAiOs running holds its profile's lock. The registration is only a probe, in memory (nothing flushed).
  const probe = o.profiles.createProfile(chosen.at, NAME, SOURCE);
  // A profile of that name that is not ours: left alone.
  if (probe.rootDir.path !== chosen.at) return "done";
  try {
    probe.lock({}).unlock();
  } catch {
    probe.remove(false);
    return "blocked";
  }
  probe.remove(false);
  // Line 6. On a retry (line 9) only the data folder's rename, if it failed last time.
  const moveData = (await exists(oldData)) && !(await exists(newData));
  try {
    if (!state) await writeState(o, { state: "pending", profile: chosen.id });
    if (moveData) await fs.rename(oldData, newData);
  } catch (e) {
    // Starting anyway would create an empty ~/Ressac: the spaces and tabs parted from the profile for good.
    console.error("[carry-over] data folder not moved:", e);
    return "data-blocked";
  }
  if (!state || moveData) {
    const workspace = `${newData}/workspace`;
    if ((await exists(`${workspace}/.webaios`)) && !(await exists(`${workspace}/.ressac`))) await fs.rename(`${workspace}/.webaios`, `${workspace}/.ressac`);
    for (const cache of CACHES) await fs.rm(`${newData}/${cache}`, { recursive: true, force: true }).catch((e) => console.warn("[carry-over] cache not erased:", e));
  }
  // Line 7.
  if (chosen.at !== target) {
    await fs.mkdir(`${o.appSupport}/Ressac/Profiles`, { recursive: true });
    await fs.rename(chosen.at, target);
  }
  const adopted = o.profiles.createProfile(target, NAME, SOURCE);
  o.profiles.defaultProfile = adopted;
  o.profiles.flush();
  await writeState(o, { state: "done", profile: target });
  // Line 8.
  return restart(o, adopted);
}

/** True once, on the first normal start after a carry-over: the caller tells the person. */
export async function tellOnce(o: Options): Promise<boolean> {
  if (guarded(o)) return false;
  const state = await readState(o);
  if (state?.state !== "done" || state.told) return false;
  await writeState(o, { ...state, told: true });
  return true;
}
