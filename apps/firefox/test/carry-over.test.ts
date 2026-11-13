// The carry-over from WebAiOs, on temp folders and a fake profile service. The profile part cannot run in an e2e: macOS
// gives Firefox its profile root (FSFindFolder), not $HOME, so no launch can be pointed at a fake one. Its proof is the
// VM trial of plan 61 (Task 6): a machine with WebAiOs installed and used, then Ressac launched.
import { access, chmod, mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { carryOver, carryPrefs, tellOnce, type Env, type Profile, type ProfileService } from "../chrome/store/carry-over";

const exists = (p: string) => access(p).then(() => true, () => false);
const write = async (path: string, text: string) => (await mkdir(join(path, ".."), { recursive: true }), writeFile(path, text));

const locked: string[] = [];
afterEach(async () => {
  for (const dir of locked.splice(0)) await chmod(dir, 0o755);
});

/**
 * Like the real service: the running profile is registered as `default-ressac` (Firefox names a new install's profile
 * `default-<update channel>`), and an existing name returns its profile whatever the folder passed.
 */
function fakeProfiles(o: { current?: boolean | string; registered?: Record<string, string>; firstRun?: boolean; inUse?: string[]; lockFails?: string[]; createFails?: boolean; flushFails?: boolean } = {}) {
  const calls: unknown[][] = [];
  const byName = new Map<string, Profile>();
  const register = (dir: string, name: string): Profile => {
    const profile: Profile = {
      rootDir: { path: dir },
      localDir: { path: `/caches/${dir.slice(dir.lastIndexOf("/") + 1)}` },
      lock() {
        calls.push(["lock", dir]);
        if (o.inUse?.includes(dir)) throw Object.assign(new Error("NS_ERROR_FILE_ACCESS_DENIED"), { result: 0x80520015 });
        if (o.lockFails?.includes(dir)) throw Object.assign(new Error("NS_ERROR_FAILURE"), { result: 0x80004005 });
        return { unlock: () => void calls.push(["unlock", dir]) };
      },
      remove(files) {
        calls.push(["remove", dir, files]);
        byName.delete(name);
      },
    };
    byName.set(name, profile);
    return profile;
  };
  const current = o.current === false ? null : register(typeof o.current === "string" ? o.current : "/fresh", "default-ressac");
  for (const [name, dir] of Object.entries(o.registered ?? {})) register(dir, name);
  const service: ProfileService & { calls: unknown[][] } = {
    calls,
    currentProfile: current,
    isFirstRun: o.firstRun ?? true,
    createProfile(...args: [string, string, string]) {
      calls.push(["createProfile", ...args]);
      if (o.createFails) throw new Error("NS_ERROR_FILE_ACCESS_DENIED creating times.json");
      const [dir, name] = args;
      return byName.get(name) ?? register(dir, name);
    },
    get defaultProfile() {
      return null;
    },
    set defaultProfile(p: Profile | null) {
      calls.push(["default", p?.rootDir.path]);
    },
    flush() {
      calls.push(["flush"]);
      if (o.flushFails) throw new Error("NS_ERROR_DATABASE_CHANGED");
    },
  };
  return service;
}

function fakeEnv(values: Record<string, string> = {}): Env & { values: Record<string, string> } {
  return { values, get: (name) => values[name] ?? "", set: (name, value) => void (values[name] = value) };
}

const PROFILES_INI = (paths: string[]) => paths.map((p, i) => `[Profile${i}]\nName=p${i}\nIsRelative=1\nPath=Profiles/${p}\n`).join("\n");

/** A machine that had WebAiOs: its data folder and its profile root, with `profiles` (folder → LastPlatformDir, prefs.js age). */
async function machine(o: { profiles?: Record<string, { platform?: string; age?: number }>; installs?: string; data?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), "carry-"));
  const home = join(base, "home");
  const appSupport = join(base, "support");
  const root = join(appSupport, "WebAiOs");
  const profiles = o.profiles ?? { "a.default-webaios": { platform: "/Applications/WebAiOs.app/Contents/Resources" } };
  await write(join(root, "profiles.ini"), PROFILES_INI(Object.keys(profiles)));
  for (const [folder, p] of Object.entries(profiles)) {
    const dir = join(root, "Profiles", folder);
    await write(join(dir, "cookies.sqlite"), folder);
    if (p.platform) await write(join(dir, "compatibility.ini"), `[Compatibility]\nLastVersion=0.1.3\nLastPlatformDir=${p.platform}\n`);
    await write(join(dir, "prefs.js"), "");
    const t = Date.now() / 1000 - (p.age ?? 0);
    await utimes(join(dir, "prefs.js"), t, t);
  }
  if (o.installs) await write(join(root, "installs.ini"), o.installs);
  await mkdir(join(appSupport, "Ressac", "Profiles", "x.default-release"), { recursive: true });
  if (o.data !== false) {
    await write(join(home, "WebAiOs", "session.json"), "{}");
    await write(join(home, "WebAiOs", "workspace", ".webaios", "mcp.json"), "{}");
    await write(join(home, "WebAiOs", "workspace", "projects", "p.txt"), "p");
    for (const cache of ["webaios-sites", "webaios-widgets", "webaios-components"]) await write(join(home, "WebAiOs", cache, "x", "copy.html"), "");
  }
  return { home, appSupport, root, ressac: join(appSupport, "Ressac") };
}

const state = async (appSupport: string) => JSON.parse(await readFile(join(appSupport, "Ressac", "carried.json"), "utf8"));
const writeState = (appSupport: string, s: object) => write(join(appSupport, "Ressac", "carried.json"), JSON.stringify(s));

describe("carryOver", () => {
  // Line 1.
  it.each([
    ["the profile was given on the command line", { current: false }, {}],
    ["RESSAC_DATA_DIR is set", {}, { RESSAC_DATA_DIR: "/tmp/d" }],
    ["RESSAC_TEST_NO_SYSTEM is set", {}, { RESSAC_TEST_NO_SYSTEM: "1" }],
  ])("does nothing when %s", async (_, p, e) => {
    const m = await machine();
    const profiles = fakeProfiles(p);
    expect(await carryOver({ ...m, profiles, env: fakeEnv(e) })).toBe("done");
    expect(profiles.calls).toEqual([]);
    expect(await exists(join(m.home, "WebAiOs"))).toBe(true);
    expect(await exists(join(m.ressac, "carried.json"))).toBe(false);
  });

  // Line 2.
  it("a moved app (first run, state done) adopts the carried profile again and restarts", async () => {
    const m = await machine();
    const folder = join(m.ressac, "Profiles", "x.default-release");
    await writeState(m.appSupport, { state: "done", profile: folder });
    const profiles = fakeProfiles({ firstRun: true });
    const env = fakeEnv();
    expect(await carryOver({ ...m, profiles, env })).toBe("restart");
    expect(profiles.calls).toEqual([["createProfile", folder, "webaios-carried", "carry-over"], ["default", folder], ["flush"]]);
    expect(env.values).toEqual({ XRE_PROFILE_PATH: folder, XRE_PROFILE_LOCAL_PATH: "/caches/x.default-release" });
    expect(await exists(join(m.home, "WebAiOs"))).toBe(true);
  });

  it("state done, not a first run: a normal start", async () => {
    const m = await machine();
    await writeState(m.appSupport, { state: "done", profile: join(m.ressac, "Profiles", "x.default-release") });
    const profiles = fakeProfiles({ firstRun: false });
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("done");
    expect(profiles.calls).toEqual([]);
  });

  it("state done, first run, the recorded folder gone: a normal start", async () => {
    const m = await machine();
    await writeState(m.appSupport, { state: "done", profile: join(m.ressac, "Profiles", "gone") });
    const profiles = fakeProfiles({ firstRun: true });
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("done");
    expect(profiles.calls).toEqual([]);
  });

  // Line 3.
  it("no WebAiOs profile root: a fresh Ressac, nothing touched", async () => {
    const m = await machine();
    await import("node:fs/promises").then((fs) => fs.rm(m.root, { recursive: true }));
    const profiles = fakeProfiles();
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("done");
    expect(profiles.calls).toEqual([]);
    expect(await exists(join(m.home, "WebAiOs"))).toBe(true);
  });

  it("~/Ressac already there: nothing touched, whatever the old folders hold", async () => {
    const m = await machine();
    await mkdir(join(m.home, "Ressac"));
    const profiles = fakeProfiles();
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("done");
    expect(profiles.calls).toEqual([]);
    expect(await exists(join(m.home, "WebAiOs"))).toBe(true);
    expect(await exists(join(m.root, "Profiles", "a.default-webaios"))).toBe(true);
  });

  // Line 4.
  it("chooses the profile of an installed WebAiOs.app, then the most recently used", async () => {
    const m = await machine({
      profiles: {
        "dev.default": { platform: "/src/engine/obj/dist/WebAiOs.app/Contents/Resources", age: 0 },
        "nightly.default": { platform: "/src/engine/obj/dist/Nightly.app/Contents/Resources", age: 0 },
        "old.default": { platform: "/Applications/WebAiOs.app/Contents/Resources", age: 7200 },
        "main.default": { platform: "/Applications/WebAiOs.app/Contents/Resources", age: 60 },
      },
    });
    const profiles = fakeProfiles();
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("restart");
    expect(profiles.calls[0]).toEqual(["createProfile", join(m.root, "Profiles", "main.default"), "webaios-carried-probe", "carry-over"]);
    expect(await exists(join(m.ressac, "Profiles", "main.default"))).toBe(true);
    expect(await exists(join(m.root, "Profiles", "old.default"))).toBe(true);
  });

  it("without one, a dev WebAiOs.app profile, the most recent first; never another app's", async () => {
    const m = await machine({
      profiles: {
        "nightly.default": { platform: "/obj/dist/Nightly.app/Contents/Resources", age: 0 },
        "older.default": { platform: "/obj/dist/WebAiOs.app/Contents/Resources", age: 7200 },
        "dev.default": { platform: "/obj/dist/WebAiOs.app/Contents/Resources", age: 60 },
      },
    });
    const profiles = fakeProfiles();
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("restart");
    expect(profiles.calls[0]![1]).toBe(join(m.root, "Profiles", "dev.default"));
  });

  it("no WebAiOs.app profile: the default of a locked install", async () => {
    const m = await machine({
      profiles: { "a.default": {}, "b.default": {} },
      installs: "[AAAA]\nDefault=Profiles/a.default\n\n[BBBB]\nDefault=Profiles/b.default\nLocked=1\n",
    });
    const profiles = fakeProfiles();
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("restart");
    expect(profiles.calls[0]![1]).toBe(join(m.root, "Profiles", "b.default"));
  });

  it("no profile to take: the data folder alone is carried, a normal start", async () => {
    const m = await machine({ profiles: { "n.default": { platform: "/Applications/Nightly.app/Contents/Resources" } }, installs: "[AAAA]\nDefault=Profiles/n.default\n" });
    const profiles = fakeProfiles();
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("done");
    expect(profiles.calls).toEqual([]);
    expect(await exists(join(m.home, "WebAiOs"))).toBe(false);
    expect(await exists(join(m.home, "Ressac", "workspace", ".ressac", "mcp.json"))).toBe(true);
    expect(await exists(join(m.root, "Profiles", "n.default"))).toBe(true);
  });

  // M3: absolute paths.
  it("an absolute profile path (IsRelative=0) is taken where it is", async () => {
    const m = await machine({ profiles: {} });
    const abs = join(m.home, "..", "elsewhere", "z.default");
    await write(join(abs, "compatibility.ini"), "[Compatibility]\nLastPlatformDir=/Applications/WebAiOs.app/Contents/Resources\n");
    await write(join(m.root, "profiles.ini"), `[Profile0]\nName=z\nIsRelative=0\nPath=${abs}\n`);
    const profiles = fakeProfiles();
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("restart");
    expect(profiles.calls[0]![1]).toBe(abs);
    expect(await exists(join(m.ressac, "Profiles", "z.default"))).toBe(true);
  });

  it("an absolute Default in installs.ini is taken where it is", async () => {
    const m = await machine({ profiles: {} });
    const abs = join(m.home, "..", "elsewhere", "y.default");
    await write(join(abs, "prefs.js"), "");
    await write(join(m.root, "profiles.ini"), `[Profile0]\nName=y\nIsRelative=0\nPath=${abs}\n`);
    await write(join(m.root, "installs.ini"), `[AAAA]\nDefault=${abs}\nLocked=1\n`);
    const profiles = fakeProfiles();
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("restart");
    expect(profiles.calls[0]![1]).toBe(abs);
  });

  // Line 5.
  it("WebAiOs still running: blocked, its registration removed, nothing moved, written or flushed", async () => {
    const m = await machine();
    const old = join(m.root, "Profiles", "a.default-webaios");
    const profiles = fakeProfiles({ inUse: [old] });
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("blocked");
    expect(profiles.calls).toEqual([["createProfile", old, "webaios-carried-probe", "carry-over"], ["lock", old], ["remove", old, false]]);
    expect(await exists(join(m.home, "WebAiOs"))).toBe(true);
    expect(await exists(join(m.home, "Ressac"))).toBe(false);
    expect(await exists(old)).toBe(true);
    expect(await exists(join(m.ressac, "carried.json"))).toBe(false);
  });

  // Lines 5 to 8: the whole carry-over.
  it("moves the data folder and the profile, adopts it, and restarts on it", async () => {
    const m = await machine();
    const old = join(m.root, "Profiles", "a.default-webaios");
    const moved = join(m.ressac, "Profiles", "a.default-webaios");
    const profiles = fakeProfiles();
    const env = fakeEnv();
    expect(await carryOver({ ...m, profiles, env })).toBe("restart");
    // Line 5: the in-use test, its registration dropped.
    expect(profiles.calls.slice(0, 4)).toEqual([["createProfile", old, "webaios-carried-probe", "carry-over"], ["lock", old], ["unlock", old], ["remove", old, false]]);
    // Line 6: the data folder, the agent's folder; the caches only are deleted.
    expect(await exists(join(m.home, "WebAiOs"))).toBe(false);
    expect(await readFile(join(m.home, "Ressac", "session.json"), "utf8")).toBe("{}");
    expect(await readFile(join(m.home, "Ressac", "workspace", "projects", "p.txt"), "utf8")).toBe("p");
    expect(await readFile(join(m.home, "Ressac", "workspace", ".ressac", "mcp.json"), "utf8")).toBe("{}");
    expect(await exists(join(m.home, "Ressac", "workspace", ".webaios"))).toBe(false);
    expect((await readdir(join(m.home, "Ressac"))).sort()).toEqual(["session.json", "workspace"]);
    // Line 7: the profile moved whole, registered there, made the default, flushed, the state done.
    expect(await exists(old)).toBe(false);
    expect(await readFile(join(moved, "cookies.sqlite"), "utf8")).toBe("a.default-webaios");
    expect(profiles.calls.slice(4)).toEqual([["createProfile", moved, "webaios-carried", "carry-over"], ["default", moved], ["flush"]]);
    expect(await state(m.appSupport)).toEqual({ state: "done", profile: moved });
    // Line 8.
    expect(env.values).toEqual({ XRE_PROFILE_PATH: moved, XRE_PROFILE_LOCAL_PATH: "/caches/a.default-webaios" });
    // The fresh profile Ressac started on stays.
    expect(await exists(join(m.ressac, "Profiles", "x.default-release"))).toBe(true);
  });

  it("calls createProfile with its three arguments, always", async () => {
    const m = await machine();
    const profiles = fakeProfiles();
    await carryOver({ ...m, profiles, env: fakeEnv() });
    const creates = profiles.calls.filter((c) => c[0] === "createProfile");
    expect(creates.length).toBe(2);
    for (const c of creates) expect(c.slice(1).map((a) => typeof a)).toEqual(["string", "string", "string"]);
  });

  it("no old data folder: only the profile is carried", async () => {
    const m = await machine({ data: false });
    expect(await carryOver({ ...m, profiles: fakeProfiles(), env: fakeEnv() })).toBe("restart");
    expect(await exists(join(m.home, "Ressac"))).toBe(false);
    expect(await exists(join(m.ressac, "Profiles", "a.default-webaios"))).toBe(true);
  });

  /** A launch whose rename of ~/WebAiOs fails (the home folder read-only): blocked on the data, nothing else done. */
  async function failedRename(m: Awaited<ReturnType<typeof machine>>) {
    await chmod(m.home, 0o555);
    locked.push(m.home);
    const profiles = fakeProfiles();
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("data-blocked");
    expect(await readFile(join(m.home, "WebAiOs", "session.json"), "utf8")).toBe("{}");
    expect(await exists(join(m.home, "Ressac"))).toBe(false);
    expect(await state(m.appSupport)).toMatchObject({ state: "pending" });
    expect(await exists(join(m.root, "Profiles", "a.default-webaios"))).toBe(true);
    expect(await exists(join(m.ressac, "Profiles", "a.default-webaios"))).toBe(false);
    expect(profiles.calls.some((c) => c[0] === "flush" || c[0] === "default")).toBe(false);
    expect(profiles.calls.filter((c) => c[0] === "createProfile").length).toBe(1);
  }

  it("a rename that fails in line 6 blocks on the data: old folder intact, state pending, no profile moved", async () => {
    await failedRename(await machine());
  });

  it("the next launch, the rename failing again: blocked again", async () => {
    const m = await machine();
    await failedRename(m);
    await failedRename(m);
  });

  it("the next launch, the rename now working: data folder moved, profile adopted, restart", async () => {
    const m = await machine();
    await failedRename(m);
    await chmod(m.home, 0o755);
    const profiles = fakeProfiles();
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("restart");
    expect(await exists(join(m.home, "WebAiOs"))).toBe(false);
    expect(await readFile(join(m.home, "Ressac", "workspace", ".ressac", "mcp.json"), "utf8")).toBe("{}");
    expect((await readdir(join(m.home, "Ressac"))).sort()).toEqual(["session.json", "workspace"]);
    expect(await state(m.appSupport)).toEqual({ state: "done", profile: join(m.ressac, "Profiles", "a.default-webaios") });
  });

  // Line 9.
  it("state pending, both data folders there: they are left alone, the profile is taken", async () => {
    const m = await machine();
    await mkdir(join(m.home, "Ressac"));
    await writeState(m.appSupport, { state: "pending", profile: join(m.root, "Profiles", "a.default-webaios") });
    const profiles = fakeProfiles();
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("restart");
    expect(await exists(join(m.home, "WebAiOs", "webaios-sites"))).toBe(true);
    expect(await readdir(join(m.home, "Ressac"))).toEqual([]);
    expect(await state(m.appSupport)).toEqual({ state: "done", profile: join(m.ressac, "Profiles", "a.default-webaios") });
  });

  it("state pending, the data folder already moved: the rest of line 6 is finished", async () => {
    const m = await machine({ data: false });
    await write(join(m.home, "Ressac", "workspace", ".webaios", "x"), "");
    await write(join(m.home, "Ressac", "webaios-sites", "copy.html"), "");
    await writeState(m.appSupport, { state: "pending", profile: join(m.root, "Profiles", "a.default-webaios") });
    expect(await carryOver({ ...m, profiles: fakeProfiles(), env: fakeEnv() })).toBe("restart");
    expect(await exists(join(m.home, "Ressac", "workspace", ".ressac", "x"))).toBe(true);
    expect(await readdir(join(m.home, "Ressac"))).toEqual(["workspace"]);
  });

  it("state pending, .ressac already there: .webaios is not touched", async () => {
    const m = await machine({ data: false });
    await write(join(m.home, "Ressac", "workspace", ".webaios", "x"), "");
    await write(join(m.home, "Ressac", "workspace", ".ressac", "y"), "");
    await writeState(m.appSupport, { state: "pending", profile: join(m.root, "Profiles", "a.default-webaios") });
    expect(await carryOver({ ...m, profiles: fakeProfiles(), env: fakeEnv() })).toBe("restart");
    expect(await exists(join(m.home, "Ressac", "workspace", ".webaios", "x"))).toBe(true);
    expect(await readdir(join(m.home, "Ressac", "workspace", ".ressac"))).toEqual(["y"]);
  });

  // C1.
  it("a first attempt that throws stops Ressac: nothing moved, no ~/Ressac; the next launch carries over", async () => {
    const m = await machine();
    expect(await carryOver({ ...m, profiles: fakeProfiles({ createFails: true }), env: fakeEnv() })).toBe("profile-blocked");
    expect(await exists(join(m.home, "Ressac"))).toBe(false);
    expect(await exists(join(m.home, "WebAiOs", "session.json"))).toBe(true);
    expect(await exists(join(m.root, "Profiles", "a.default-webaios"))).toBe(true);
    expect(await state(m.appSupport)).toMatchObject({ state: "pending" });
    expect(await carryOver({ ...m, profiles: fakeProfiles(), env: fakeEnv() })).toBe("restart");
    expect(await exists(join(m.home, "Ressac", "session.json"))).toBe(true);
    expect(await state(m.appSupport)).toEqual({ state: "done", profile: join(m.ressac, "Profiles", "a.default-webaios") });
  });

  it("the target profile folder taken by another: blocked, nothing moved", async () => {
    const m = await machine();
    await mkdir(join(m.ressac, "Profiles", "a.default-webaios"));
    expect(await carryOver({ ...m, profiles: fakeProfiles(), env: fakeEnv() })).toBe("profile-blocked");
    expect(await exists(join(m.home, "WebAiOs"))).toBe(true);
    expect(await exists(join(m.home, "Ressac"))).toBe(false);
    expect(await exists(join(m.root, "Profiles", "a.default-webaios"))).toBe(true);
  });

  // I2.
  it("a flush that fails after the data moved stops Ressac, state pending; the next launch adopts", async () => {
    const m = await machine();
    expect(await carryOver({ ...m, profiles: fakeProfiles({ flushFails: true }), env: fakeEnv() })).toBe("profile-blocked");
    expect(await exists(join(m.home, "Ressac", "session.json"))).toBe(true);
    expect(await state(m.appSupport)).toMatchObject({ state: "pending" });
    const env = fakeEnv();
    expect(await carryOver({ ...m, profiles: fakeProfiles(), env })).toBe("restart");
    expect(env.values.XRE_PROFILE_PATH).toBe(join(m.ressac, "Profiles", "a.default-webaios"));
    expect(await state(m.appSupport)).toEqual({ state: "done", profile: join(m.ressac, "Profiles", "a.default-webaios") });
  });

  // Fix 1b: the real service's own `default-ressac`.
  it("Ressac's fresh profile registered as default-ressac: the old folder is still registered, adopted, restart", async () => {
    const m = await machine();
    const fresh = join(m.ressac, "Profiles", "x.default-release");
    const old = join(m.root, "Profiles", "a.default-webaios");
    const moved = join(m.ressac, "Profiles", "a.default-webaios");
    const profiles = fakeProfiles({ current: fresh });
    const env = fakeEnv();
    expect(await carryOver({ ...m, profiles, env })).toBe("restart");
    expect(profiles.calls.slice(0, 4)).toEqual([["createProfile", old, "webaios-carried-probe", "carry-over"], ["lock", old], ["unlock", old], ["remove", old, false]]);
    expect(profiles.calls.slice(4)).toEqual([["createProfile", moved, "webaios-carried", "carry-over"], ["default", moved], ["flush"]]);
    expect(env.values.XRE_PROFILE_PATH).toBe(moved);
  });

  it("a probe registration left by an earlier launch is removed before probing", async () => {
    const m = await machine();
    const old = join(m.root, "Profiles", "a.default-webaios");
    const profiles = fakeProfiles({ registered: { "webaios-carried-probe": "/elsewhere" } });
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("restart");
    expect(profiles.calls.slice(0, 4)).toEqual([["createProfile", old, "webaios-carried-probe", "carry-over"], ["remove", "/elsewhere", false], ["createProfile", old, "webaios-carried-probe", "carry-over"], ["lock", old]]);
  });

  it("webaios-carried registered on another folder: a real clash, blocked before the profile moves", async () => {
    const m = await machine();
    const profiles = fakeProfiles({ registered: { "webaios-carried": "/elsewhere" } });
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("profile-blocked");
    expect(profiles.calls.some((c) => c[0] === "flush" || c[0] === "default")).toBe(false);
    expect(await state(m.appSupport)).toMatchObject({ state: "pending" });
  });

  // M1.
  it("a lock error other than access denied is not « WebAiOs running »", async () => {
    const m = await machine();
    const old = join(m.root, "Profiles", "a.default-webaios");
    const profiles = fakeProfiles({ lockFails: [old] });
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("profile-blocked");
    expect(profiles.calls).toContainEqual(["remove", old, false]);
    expect(await exists(join(m.home, "Ressac"))).toBe(false);
  });

  // M2.
  it("state pending, Ressac already running on the adopted profile: state done, no probe", async () => {
    const m = await machine({ data: false });
    const moved = join(m.ressac, "Profiles", "a.default-webaios");
    await import("node:fs/promises").then((fs) => fs.rename(join(m.root, "Profiles", "a.default-webaios"), moved));
    await writeState(m.appSupport, { state: "pending", profile: join(m.root, "Profiles", "a.default-webaios") });
    const profiles = fakeProfiles({ current: moved });
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("done");
    expect(profiles.calls).toEqual([]);
    expect(await state(m.appSupport)).toEqual({ state: "done", profile: moved });
  });

  // Firefox rewrites a profile's compatibility.ini when Ressac runs on it: the search for « last used by WebAiOs.app »
  // no longer finds the moved profile. The pending state's own profile is used.
  const usedByRessac = (dir: string) => writeFile(join(dir, "compatibility.ini"), "[Compatibility]\nLastPlatformDir=/Applications/Ressac.app/Contents/Resources\n");

  it("state pending, Ressac already running on the adopted profile it rewrote: state done on that folder", async () => {
    const m = await machine({ data: false });
    const moved = join(m.ressac, "Profiles", "a.default-webaios");
    await import("node:fs/promises").then((fs) => fs.rename(join(m.root, "Profiles", "a.default-webaios"), moved));
    await usedByRessac(moved);
    await writeState(m.appSupport, { state: "pending", profile: join(m.root, "Profiles", "a.default-webaios") });
    const profiles = fakeProfiles({ current: moved });
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("done");
    expect(await state(m.appSupport)).toEqual({ state: "done", profile: moved });
  });

  it("state pending, the moved profile rewritten by Firefox, Ressac on its fresh one: adopted where it is", async () => {
    const m = await machine({ data: false });
    const moved = join(m.ressac, "Profiles", "a.default-webaios");
    await import("node:fs/promises").then((fs) => fs.rename(join(m.root, "Profiles", "a.default-webaios"), moved));
    await usedByRessac(moved);
    await writeState(m.appSupport, { state: "pending", profile: join(m.root, "Profiles", "a.default-webaios") });
    const env = fakeEnv();
    expect(await carryOver({ ...m, profiles: fakeProfiles(), env })).toBe("restart");
    expect(env.values.XRE_PROFILE_PATH).toBe(moved);
    expect(await state(m.appSupport)).toEqual({ state: "done", profile: moved });
  });

  it("state pending, the old profile still in place and its name taken in Ressac/Profiles: blocked, the other folder never adopted", async () => {
    const m = await machine();
    await mkdir(join(m.ressac, "Profiles", "a.default-webaios"));
    await writeState(m.appSupport, { state: "pending", profile: join(m.root, "Profiles", "a.default-webaios") });
    const profiles = fakeProfiles();
    expect(await carryOver({ ...m, profiles, env: fakeEnv() })).toBe("profile-blocked");
    expect(profiles.calls.some((c) => c[0] === "flush" || c[0] === "default")).toBe(false);
    expect(await exists(join(m.root, "Profiles", "a.default-webaios"))).toBe(true);
  });

  it("no profile to take: the state is pending before the data folder moves (a crash there is finished next launch)", async () => {
    const m = await machine({ profiles: { "n.default": { platform: "/Applications/Nightly.app/Contents/Resources" } } });
    await chmod(m.home, 0o555);
    locked.push(m.home);
    expect(await carryOver({ ...m, profiles: fakeProfiles(), env: fakeEnv() })).toBe("data-blocked");
    expect(await state(m.appSupport)).toEqual({ state: "pending", profile: "" });
    await chmod(m.home, 0o755);
    expect(await carryOver({ ...m, profiles: fakeProfiles(), env: fakeEnv() })).toBe("done");
    expect(await exists(join(m.home, "Ressac", "workspace", ".ressac", "mcp.json"))).toBe(true);
    expect(await state(m.appSupport)).toEqual({ state: "done", profile: "" });
  });

  it("state pending, the profile already moved last time: adopted where it is", async () => {
    const m = await machine();
    const moved = join(m.ressac, "Profiles", "a.default-webaios");
    await import("node:fs/promises").then((fs) => fs.rename(join(m.root, "Profiles", "a.default-webaios"), moved));
    await writeState(m.appSupport, { state: "pending", profile: join(m.root, "Profiles", "a.default-webaios") });
    const profiles = fakeProfiles();
    const env = fakeEnv();
    expect(await carryOver({ ...m, profiles, env })).toBe("restart");
    expect(profiles.calls.filter((c) => c[0] === "createProfile").map((c) => c[1])).toEqual([moved, moved]);
    expect(env.values.XRE_PROFILE_PATH).toBe(moved);
    expect(await state(m.appSupport)).toEqual({ state: "done", profile: moved });
  });
});

describe("tellOnce", () => {
  it("tells once after a carry-over", async () => {
    const m = await machine();
    await writeState(m.appSupport, { state: "done", profile: "/p" });
    const o = { ...m, profiles: fakeProfiles({ firstRun: false }), env: fakeEnv() };
    expect(await tellOnce(o)).toBe(true);
    expect(await tellOnce(o)).toBe(false);
    expect(await state(m.appSupport)).toEqual({ state: "done", profile: "/p", told: true });
  });

  it("never without a finished carry-over, nor on a guarded launch", async () => {
    const m = await machine();
    const o = { ...m, profiles: fakeProfiles(), env: fakeEnv() };
    expect(await tellOnce(o)).toBe(false);
    await writeState(m.appSupport, { state: "pending", profile: "/p" });
    expect(await tellOnce(o)).toBe(false);
    await writeState(m.appSupport, { state: "done", profile: "/p" });
    expect(await tellOnce({ ...o, env: fakeEnv({ RESSAC_TEST_NO_SYSTEM: "1" }) })).toBe(false);
    expect(await tellOnce({ ...o, profiles: fakeProfiles({ current: false }) })).toBe(false);
  });
});

describe("carryPrefs", () => {
  /** User values as nsIPrefBranch holds them; defaults (not user values) are absent. */
  const fakePrefs = (values: Record<string, unknown>) => ({
    values,
    has: (name: string) => name in values,
    get: (name: string) => values[name],
    set: (name: string, value: unknown) => void (values[name] = value),
    clear: (name: string) => void delete values[name],
  });

  it("WebAiOs's choices become Ressac's: telemetry turned off stays off, the notice is not shown again", () => {
    const prefs = fakePrefs({
      "webaios.telemetry.enabled": false,
      "webaios.telemetry.noticeShown": true,
      "webaios.call.sites": "[]",
      "webaios.extensions.pinned": '["a@b"]',
      "webaios.other": 1,
    });
    carryPrefs(prefs);
    expect(prefs.values).toEqual({
      "ressac.telemetry.enabled": false,
      "ressac.telemetry.noticeShown": true,
      "ressac.call.sites": "[]",
      "ressac.extensions.pinned": '["a@b"]',
      "webaios.other": 1,
    });
  });

  it("a value Ressac already has wins; the install id is carried", () => {
    const prefs = fakePrefs({ "webaios.telemetry.enabled": false, "ressac.telemetry.enabled": true, "webaios.telemetry.installId": "id" });
    carryPrefs(prefs);
    expect(prefs.values).toEqual({ "webaios.telemetry.enabled": false, "ressac.telemetry.enabled": true, "ressac.telemetry.installId": "id" });
  });
});
