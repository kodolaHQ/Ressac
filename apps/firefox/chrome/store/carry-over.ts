import fs from "node:fs/promises";
import { firefoxProfiles, iniSections } from "./import/sources";

/**
 * The one-time carry-over from WebAiOs, Ressac's former name: on the first launch of Ressac on a machine that had
 * WebAiOs, its data folder (`~/WebAiOs`) and its Firefox profile become Ressac's. It moves, never copies nor deletes
 * (but three disposable caches), and stops before the first move when anything is doubtful. Plain `/` joins and
 * node:fs (shimmed onto IOUtils in the store bundle) keep it testable in Node.
 */

/**
 * The old names, read for data written before the rename: the data folder under the home folder, the Firefox profile
 * root under Application Support, and WebAiOs's own prefs carried with the profile (`webaios.<name>`).
 */
export const LEGACY = {
  dataDir: "WebAiOs",
  profileRoot: "WebAiOs",
  prefPrefix: "webaios.",
  prefs: ["telemetry.enabled", "telemetry.noticeShown", "telemetry.installId", "call.sites", "extensions.pinned"],
  /** The app whose profile is taken (compatibility.ini's LastPlatformDir). */
  app: "WebAiOs.app",
  /** The agent's internal folder in the workspace, renamed `.ressac`. */
  workspaceDir: ".webaios",
  /** Disposable caches in the data folder, rebuilt at start under their new names. */
  caches: ["webaios-sites", "webaios-widgets", "webaios-components"],
};
// Firefox names a new install's profile `default-<update channel>` (`default-ressac`): never one of these. The old
// spelling is deliberate: it says where the profile came from, and never matches a name Firefox generates.
const NAME = "webaios-carried";
/** The in-use test's registration: never mistaken for the adopted profile. */
const PROBE = "webaios-carried-probe";
const SOURCE = "carry-over";
/** Set before line 2's restart: its presence means that restart already happened. */
const RESTARTED = "RESSAC_CARRIED_RESTART";

/** The parts of nsIToolkitProfile used. */
export interface Profile {
  readonly name: string;
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
  /** Returns the profile already registered under `name`, if any. */
  createProfile(rootDir: string, name: string, source: string): Profile;
  defaultProfile: Profile | null;
  flush(): void;
}
/** The parts of nsIPrefBranch used: user values only, of any type. */
export interface Prefs {
  has(name: string): boolean;
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  clear(name: string): void;
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
  /** pending: the old folder chosen (moved to Ressac/Profiles/<its name>), "" before one is; done: the adopted folder. */
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
    if (!platform.split("/").includes(LEGACY.app)) continue;
    // A build tree's WebAiOs.app (a developer's) may be the most recent: the installed app's profile is the one in use.
    const installed = ["/Applications", `${o.home}/Applications`].some((dir) => platform.startsWith(`${dir}/${LEGACY.app}/`));
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

/** XPCOM's code for a profile locked by another running instance. */
const ACCESS_DENIED = 0x80520015;

export type CarryResult = "restart" | "blocked" | "data-blocked" | "profile-blocked" | "done";

/**
 * Something to carry and not carried yet: a carry-over begun (state pending), or WebAiOs's profile root with no
 * ~/Ressac. Measured before anything moves: once it says so, Ressac never starts normally until the carry-over ends.
 */
export async function unfinished(o: Options): Promise<boolean> {
  const state = await readState(o);
  return state?.state === "pending" || (!state && (await exists(`${o.appSupport}/${LEGACY.profileRoot}`)) && !(await exists(`${o.home}/Ressac`)));
}

/**
 * Runs before anything creates the data folder. "restart": restart now, start nothing else. Each blocking result
 * means: say why, then quit (the next launch goes on from the state). "blocked": WebAiOs is running. "data-blocked":
 * ~/WebAiOs could not be moved. "profile-blocked": any other failure while there is something to carry. "done": a
 * normal start. Throws only from the launch guard (before anything is read).
 */
export async function carryOver(o: Options): Promise<CarryResult> {
  // Line 1.
  if (guarded(o)) return "done";
  const state = await readState(o);
  const carry = await unfinished(o);
  try {
    return await carryOverSteps(o, state);
  } catch (e) {
    console.error("[carry-over] failed:", e);
    if (!carry) return "done";
    if (!state) await writeState(o, { state: "pending", profile: "" }).catch(() => {});
    return "profile-blocked";
  }
}

async function carryOverSteps(o: Options, state: State | null): Promise<CarryResult> {
  // Line 2: the app moved to another path is a new install, bound to a new empty profile (Firefox may already have
  // flushed it as this install's default, so isFirstRun is no guide): back to the carried one.
  if (state?.state === "done") {
    const current = o.profiles.currentProfile!;
    // The name too: the every-launch decision never hangs on two spellings of one folder (Firefox's fresh one is never NAME).
    if (current.name === NAME || current.rootDir.path === state.profile) {
      // A restart Firefox triggers later from this process must not inherit the mark (an empty value reads as unset).
      if (o.env.get(RESTARTED)) o.env.set(RESTARTED, "");
      return "done";
    }
    if (!state.profile || !(await exists(state.profile))) return "done";
    // Restarted for this and still elsewhere: never a second restart.
    if (o.env.get(RESTARTED)) return "profile-blocked";
    try {
      const carried = o.profiles.createProfile(state.profile, NAME, SOURCE);
      if (carried.rootDir.path !== state.profile) throw new Error(`a profile named ${NAME} is at ${carried.rootDir.path}`);
      o.profiles.defaultProfile = carried;
      o.profiles.flush();
      // Inherited by the restarted process like XRE_PROFILE_PATH (MacLaunchHelper passes the live environment).
      o.env.set(RESTARTED, "1");
      return restart(o, carried);
    } catch (e) {
      console.error("[carry-over] carried profile not restored:", e);
      return "profile-blocked";
    }
  }
  const root = `${o.appSupport}/${LEGACY.profileRoot}`;
  const oldData = `${o.home}/${LEGACY.dataDir}`;
  const newData = `${o.home}/Ressac`;
  // Line 3. Line 9: a pending state goes on from line 4.
  if (!state && (!(await exists(root)) || (await exists(newData)))) return "done";
  /** Line 6's data folder: moved when it is there and ~/Ressac is not (a retry too). False: it could not be. */
  const moveData = async (): Promise<boolean> => {
    if (!(await exists(oldData)) || (await exists(newData))) return true;
    try {
      await fs.rename(oldData, newData);
      return true;
    } catch (e) {
      // Starting anyway would create an empty ~/Ressac: the spaces and tabs parted from the profile for good.
      console.error("[carry-over] data folder not moved:", e);
      return false;
    }
  };
  /** The rest of line 6, once the data lives in ~/Ressac only (on a retry too: a previous launch may have died here). */
  const tidyData = async () => {
    if (!(await exists(newData))) return;
    const workspace = `${newData}/workspace`;
    const old = `${workspace}/${LEGACY.workspaceDir}`;
    if ((await exists(old)) && !(await exists(`${workspace}/.ressac`))) await fs.rename(old, `${workspace}/.ressac`);
    for (const cache of LEGACY.caches) await fs.rm(`${newData}/${cache}`, { recursive: true, force: true }).catch((e) => console.warn("[carry-over] cache not erased:", e));
  };
  // Line 4.
  const movedTo = (id: string) => `${o.appSupport}/Ressac/Profiles/${leaf(id)}`;
  // A carry-over begun goes on with the profile it recorded (its target is movedTo of it), wherever it is now: once
  // Ressac ran on the moved one, Firefox rewrote its compatibility.ini and the search no longer knows it.
  // Still at its old place first, as the search does: a folder of its name in Ressac/Profiles is then another's.
  const begun = state?.profile ? ((await exists(state.profile)) ? state.profile : (await exists(movedTo(state.profile))) ? movedTo(state.profile) : null) : null;
  const chosen = begun ? { id: state!.profile, at: begun } : await oldProfile(o, root, movedTo, !!state);
  // No profile to take: the data folder alone is carried.
  if (!chosen) {
    // Nothing to carry (no ~/WebAiOs), and nothing carried by an earlier attempt: no state, nothing announced.
    if (!(await exists(oldData)) && !(state && (await exists(newData)))) {
      if (state) await writeState(o, { state: "done", profile: "", told: true });
      return "done";
    }
    // Pending first: a crash between the move and the tidy-up is finished at the next launch.
    try {
      if (!state) await writeState(o, { state: "pending", profile: "" });
    } catch (e) {
      console.error("[carry-over] state not written:", e);
      return "data-blocked";
    }
    if (!(await moveData())) return "data-blocked";
    await tidyData();
    await writeState(o, { state: "done", profile: "" });
    return "done";
  }
  const target = movedTo(chosen.id);
  // A previous launch adopted it and could not write "done": Ressac already runs on it.
  if (state && o.profiles.currentProfile?.rootDir.path === target) {
    await tidyData();
    await writeState(o, { state: "done", profile: o.profiles.currentProfile.rootDir.path });
    return "done";
  }
  // Another folder of that name already there: never moved into (IOUtils.move would put it inside).
  if (chosen.at !== target && (await exists(target))) throw new Error(`${target} already exists`);
  // Line 5: WebAiOs running holds its profile's lock. The registration is only a probe, in memory (nothing flushed).
  let probe = o.profiles.createProfile(chosen.at, PROBE, SOURCE);
  // An existing name returns its profile whatever the folder: a probe left by an earlier launch goes first.
  if (probe.rootDir.path !== chosen.at) {
    probe.remove(false);
    probe = o.profiles.createProfile(chosen.at, PROBE, SOURCE);
  }
  try {
    probe.lock({}).unlock();
  } catch (e) {
    probe.remove(false);
    if ((e as { result?: number })?.result === ACCESS_DENIED) return "blocked";
    throw e;
  }
  probe.remove(false);
  // Line 6.
  try {
    // A pending state without a profile (an earlier failure, or a data-only attempt) records it too.
    if (!state?.profile) await writeState(o, { state: "pending", profile: chosen.id });
  } catch (e) {
    console.error("[carry-over] state not written:", e);
    return "data-blocked";
  }
  if (!(await moveData())) return "data-blocked";
  await tidyData();
  // Line 7.
  if (chosen.at !== target) {
    await fs.mkdir(`${o.appSupport}/Ressac/Profiles`, { recursive: true });
    await fs.rename(chosen.at, target);
  }
  const adopted = o.profiles.createProfile(target, NAME, SOURCE);
  if (adopted.rootDir.path !== target) throw new Error(`a profile named ${NAME} is at ${adopted.rootDir.path}`);
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

/** At every start, before telemetry: each of WebAiOs's prefs the person set becomes Ressac's, unless Ressac has one. */
export function carryPrefs(prefs: Prefs): void {
  for (const name of LEGACY.prefs) {
    const old = `${LEGACY.prefPrefix}${name}`;
    if (!prefs.has(old) || prefs.has(`ressac.${name}`)) continue;
    prefs.set(`ressac.${name}`, prefs.get(old));
    prefs.clear(old);
  }
}
