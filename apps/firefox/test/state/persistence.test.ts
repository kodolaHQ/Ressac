import { expect, test, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../core/state/actions";
import { initialState } from "../../core/state/initial-state";
import { loadSession, SessionRecorder } from "../../core/state/persistence";
import type { BrowserState } from "../../shared/model";
import { DEFAULT_CODEX_ENGINE } from "../../shared/settings";

const folder = () => mkdtempSync(join(tmpdir(), "webaios-session-"));
const set_aside = (d: string, suffix: string) => readdirSync(d).filter((f) => f.startsWith("session.json.") && f.endsWith(suffix));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function richState(): BrowserState {
  let n = 0;
  const g = () => `g${++n}`;
  let e = initialState(g);
  const F = e.windows[0]!.id;
  e = apply(e, { type: "openTab", windowId: F, url: "https://a.test/" }, g);
  e = apply(e, { type: "openTab", windowId: F, url: "https://b.test/" }, g);
  const [a, b] = Object.keys(e.tabs);
  e = apply(e, { type: "updateTab", id: a!, fields: { title: "A", zoom: 1.2, loading: true, canGoBack: true, crashed: true } }, g);
  e = apply(e, { type: "pinTab", id: b! }, g);
  e = apply(e, { type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default" }, g);
  return e;
}

test("round trip: identical, apart from volatile fields reset to defaults", async () => {
  const d = folder();
  const state = richState();
  const recorder = new SessionRecorder(d);
  recorder.schedule(state);
  await recorder.clear();
  const reviewed = await loadSession(d);
  const a = Object.values(reviewed.tabs).find((o) => o.url === "https://a.test/")!;
  expect(a).toMatchObject({ title: "A", zoom: 1.2, loading: false, canGoBack: false, canGoForward: false, crashed: false });
  const expected = structuredClone(state);
  for (const o of Object.values(expected.tabs)) Object.assign(o, { loading: false, canGoBack: false, canGoForward: false, crashed: false, error: null });
  expect(reviewed).toEqual(expected);
});

test("session v3 with a private space and a second sign-in profile: identical round trip", async () => {
  const d = folder();
  let n = 100;
  const g = () => `h${++n}`;
  const state = apply(richState(), { type: "createSpace", name: "Banque", icon: "🏦", private: true, profile: "new" }, g);
  expect(state.profiles).toHaveLength(2);
  const recorder = new SessionRecorder(d);
  recorder.schedule(state);
  await recorder.clear();
  const reviewed = await loadSession(d);
  expect(reviewed.version).toBe(3);
  expect(reviewed.profiles).toEqual(state.profiles);
  expect(reviewed.spaces).toEqual(state.spaces);
});

test("a session saved before the windows' frame loads (frame = null)", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { windows: Record<string, unknown>[] };
  for (const f of old.windows) delete f.frame;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  const e = await loadSession(d);
  expect(e.windows[0]!.frame).toBeNull();
  expect(set_aside(d, ".corrupt")).toEqual([]);
});

test("missing file → initial state", async () => {
  const e = await loadSession(folder());
  expect(e.spaces).toHaveLength(1);
  expect(e.windows).toHaveLength(1);
});

test("invalid JSON → initial state and old file set aside (….corrupt)", async () => {
  const d = folder();
  writeFileSync(join(d, "session.json"), "{ pas du json");
  const e = await loadSession(d);
  expect(e.tabs).toEqual({});
  const [kept] = set_aside(d, ".corrupt");
  expect(readFileSync(join(d, kept!), "utf8")).toBe("{ pas du json");
});

test("corrupted session: the name of the file set aside is returned to warn the user, nothing without a file", async () => {
  const d = folder();
  const kept = vi.fn();
  await loadSession(d, kept);
  expect(kept).not.toHaveBeenCalled();
  writeFileSync(join(d, "session.json"), "{ pas du json");
  await loadSession(d, kept);
  expect(kept).toHaveBeenCalledWith(join(d, set_aside(d, ".corrupt")[0]!));
});

test("unknown version → initial state and file set aside", async () => {
  const d = folder();
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...richState(), version: 4 }));
  const e = await loadSession(d);
  expect(e.tabs).toEqual({});
  expect(set_aside(d, ".corrupt")).toHaveLength(1);
});

test("two corrupted sessions in a row: the second does not overwrite the first", async () => {
  const d = folder();
  writeFileSync(join(d, "session.json"), "premier");
  await loadSession(d);
  writeFileSync(join(d, "session.json"), "second");
  await loadSession(d);
  const guards = set_aside(d, ".corrupt").map((f) => readFileSync(join(d, f), "utf8"));
  expect(guards.sort()).toEqual(["premier", "second"]);
});

test("unreadable session (permissions) → initial state, and the next save does not overwrite it", async () => {
  const d = folder();
  const path = join(d, "session.json");
  writeFileSync(path, JSON.stringify(richState()));
  chmodSync(path, 0o000);
  const e = await loadSession(d);
  expect(e.tabs).toEqual({});
  const recorder = new SessionRecorder(d, 0);
  recorder.schedule(e);
  await recorder.clear();
  const [kept] = set_aside(d, ".unreadable");
  chmodSync(join(d, kept!), 0o600);
  expect(Object.keys(JSON.parse(readFileSync(join(d, kept!), "utf8")).tabs)).toHaveLength(2);
});

test("inconsistent state (no space) → initial state", async () => {
  const d = folder();
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...richState(), spaces: [] }));
  expect((await loadSession(d)).spaces).toHaveLength(1);
});

test("planifier batches writes (3 close calls → 1 write)", async () => {
  const d = folder();
  const spy = vi.spyOn(fsp, "rename");
  const recorder = new SessionRecorder(d, 50);
  const e = richState();
  recorder.schedule(e);
  recorder.schedule(e);
  recorder.schedule(e);
  await wait(150);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

test("atomic write: goes through a temporary file then rename", async () => {
  const d = folder();
  const spy = vi.spyOn(fsp, "rename");
  const recorder = new SessionRecorder(d);
  recorder.schedule(richState());
  await recorder.clear();
  expect(spy.mock.calls[0]![0]).toMatch(/session\.json\..*tmp$/);
  expect(spy.mock.calls[0]![1]).toBe(join(d, "session.json"));
  spy.mockRestore();
});

test("vider() writes the pending state immediately; with nothing pending, does nothing", async () => {
  const d = folder();
  const recorder = new SessionRecorder(d, 10_000);
  await recorder.clear();
  expect(existsSync(join(d, "session.json"))).toBe(false);
  recorder.schedule(richState());
  await recorder.clear();
  expect(existsSync(join(d, "session.json"))).toBe(true);
});

test("vider() waits for the write in progress: nothing is lost on exit, no temporary file remains", async () => {
  const d = folder();
  const recorder = new SessionRecorder(d, 10_000);
  const a = richState();
  const b = apply(a, { type: "chooseEngine", engine: "qwant" });
  recorder.schedule(a);
  const first = recorder.clear(); // write in progress…
  const output = recorder.clear(); // …the exit has nothing pending any more, but must wait
  await output;
  expect(existsSync(join(d, "session.json"))).toBe(true);
  recorder.schedule(b);
  await Promise.all([recorder.clear(), recorder.clear(), first]);
  expect(JSON.parse(readFileSync(join(d, "session.json"), "utf8")).settings.engine).toBe("qwant");
  const { readdirSync } = await import("node:fs");
  expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("a failed write leaves no temporary file and the state is rewritten on the next vider()", async () => {
  const d = folder();
  const spy = vi.spyOn(fsp, "rename").mockRejectedValueOnce(new Error("disque plein"));
  const recorder = new SessionRecorder(d, 10_000);
  recorder.schedule(richState());
  await recorder.clear();
  expect(readdirSync(d)).toEqual([]);
  await recorder.clear();
  expect(Object.keys(JSON.parse(readFileSync(join(d, "session.json"), "utf8")).tabs)).toHaveLength(2);
  spy.mockRestore();
});

test("a tab's load error is not saved", async () => {
  const d = folder();
  let e = richState();
  const id = Object.keys(e.tabs)[0]!;
  e = apply(e, { type: "updateTab", id, fields: { error: "ERR_NAME_NOT_RESOLVED" } });
  const recorder = new SessionRecorder(d);
  recorder.schedule(e);
  await recorder.clear();
  expect((await loadSession(d)).tabs[id]?.error).toBeNull();
});

test("a session saved without agentProfile loads with claude", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  delete old.settings.agentProfile;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  const e = await loadSession(d);
  expect(e.settings.agentProfile).toBe("claude");
  expect(set_aside(d, ".corrupt")).toEqual([]);
});

test("a session saved without codexEngine loads with the default; an unknown one too", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  delete old.settings.codexEngine;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.codexEngine).toEqual(DEFAULT_CODEX_ENGINE);
  old.settings.codexEngine = { kind: "autre" };
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.codexEngine).toEqual(DEFAULT_CODEX_ENGINE);
});

test("a session saved without decisionModel loads with pplx-decider-flash; an unknown value too", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  delete old.settings.decisionModel;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.decisionModel).toBe("pplx-decider-flash");
  old.settings.decisionModel = "inconnu";
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  const e = await loadSession(d);
  expect(e.settings.decisionModel).toBe("pplx-decider-flash");
  expect(set_aside(d, ".corrupt")).toEqual([]);
});

test("a session saved without agent panel width loads with 420", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  delete old.settings.agentPanelWidth;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  const e = await loadSession(d);
  expect(e.settings.agentPanelWidth).toBe(420);
  expect(set_aside(d, ".corrupt")).toEqual([]);
});

test("session v2 where a space uses an unlisted sign-in profile: the profile is added to the list", async () => {
  const d = folder();
  const state = richState();
  state.spaces[1]!.profile = "orphelin";
  writeFileSync(join(d, "session.json"), JSON.stringify(state));
  const reviewed = await loadSession(d);
  expect(reviewed.profiles).toEqual([{ id: "default" }, { id: "orphelin" }]);
  expect(reviewed.spaces[1]!.profile).toBe("orphelin");
});

test("a space without aura, or with an unknown one, loads as aube", async () => {
  for (const aura of [undefined, "violet"]) {
    const d = folder();
    const state = initialState();
    writeFileSync(join(d, "session.json"), JSON.stringify({ ...state, spaces: [{ ...state.spaces[0], aura }] }));
    const loaded = await loadSession(d);
    expect(loaded.spaces[0]!.aura).toBe("aube");
    expect(set_aside(d, "")).toEqual([]);
  }
});
