import { expect, test, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../core/state/actions";
import { initialState } from "../../core/state/initial-state";
import { lazySave, loadSession, SessionRecorder } from "../../core/state/persistence";
import type { BrowserState } from "../../shared/model";
import { DEFAULT_CLAUDE_ENGINE, DEFAULT_CODEX_ENGINE } from "../../shared/settings";

const folder = () => mkdtempSync(join(tmpdir(), "ressac-session-"));
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
  // The round trips compare what each window shows: the launch on home (tested apart) would blank it.
  e = apply(e, { type: "setStartOnHome", enabled: false }, g);
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

test("a session reloaded has no agent search band", async () => {
  const d = folder();
  const state = richState();
  const a = Object.keys(state.tabs)[0]!;
  state.tabs[a]!.agentSearch = { state: "working", text: "x", pages: 1, startedAt: 1 };
  const recorder = new SessionRecorder(d);
  recorder.schedule(state);
  await recorder.clear();
  expect((await loadSession(d)).tabs[a]!.agentSearch).toBeUndefined();
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

test("a session from before the custom engine loads unchanged; an unknown engine falls back to Google", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  delete old.settings.customEngine;
  old.settings.engine = "qwant";
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings).toMatchObject({ engine: "qwant", customEngine: null });
  old.settings.customEngine = "http://x.com/?q=%s";
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.customEngine).toBeNull();
  old.settings.engine = "yahoo";
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.engine).toBe("google");
  expect(set_aside(d, ".corrupt")).toEqual([]);
});

test("a session from before languages stays French; the shown language is never saved", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown>; locale?: string };
  delete old.settings.language;
  delete old.locale;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.language).toBe("fr");
  old.settings.language = "../x";
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.language).toBe("system");
  const recorder = new SessionRecorder(d, 10_000);
  recorder.schedule({ ...initialState(), locale: "fr" });
  await recorder.clear();
  expect(JSON.parse(readFileSync(join(d, "session.json"), "utf8")).locale).toBeUndefined();
});

test("AI: an existing session keeps it on, a new install starts off, aiSetup is never saved", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  delete old.settings.aiEnabled;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.aiEnabled).toBe(true);
  old.settings.aiEnabled = "yes";
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.aiEnabled).toBe(true);
  expect(initialState().settings.aiEnabled).toBe(false);
  const bad = folder();
  writeFileSync(join(bad, "session.json"), "{ not json");
  expect((await loadSession(bad)).settings.aiEnabled).toBe(true);
  // Valid JSON failing the schema: an explicit false survives, anything else stays on.
  writeFileSync(join(bad, "session.json"), JSON.stringify({ spaces: 3, settings: { aiEnabled: false } }));
  expect((await loadSession(bad)).settings.aiEnabled).toBe(false);
  writeFileSync(join(bad, "session.json"), JSON.stringify({ spaces: 3, settings: { aiEnabled: "no" } }));
  expect((await loadSession(bad)).settings.aiEnabled).toBe(true);
  const recorder = new SessionRecorder(d, 10_000);
  recorder.schedule({ ...initialState(), aiSetup: true, welcomeReplay: true });
  await recorder.clear();
  expect(JSON.parse(readFileSync(join(d, "session.json"), "utf8")).aiSetup).toBeUndefined();
  expect(JSON.parse(readFileSync(join(d, "session.json"), "utf8")).welcomeReplay).toBeUndefined();
  expect((await loadSession(d)).aiSetup).toBe(false);
  expect((await loadSession(d)).welcomeReplay).toBe(false);
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

test("fresh folder welcomes", async () => {
  const s = await loadSession(folder());
  expect(s.settings.onboarded).toBe(false);
  expect(s.settings.hints).toEqual({ enabled: true, seen: [] });
});

test("the sidebar side loads left when missing or unknown, right when saved", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  delete old.settings.sidebarSide;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.sidebarSide).toBe("left");
  old.settings.sidebarSide = "top";
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.sidebarSide).toBe("left");
  old.settings.sidebarSide = "right";
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.sidebarSide).toBe("right");
});

test("shortcuts: missing loads empty, unknown ids and malformed bindings are dropped, the rest kept", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  delete old.settings.shortcuts;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.shortcuts).toEqual({});
  const k = { key: "k", shift: false, alt: false, ctrl: false, meta: true };
  old.settings.shortcuts = { nope: k, agent: k, history: { key: 3 } };
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.shortcuts).toEqual({ agent: k });
});

test("shortcuts: an inherited property name is no id, a clashing or reserved override is dropped", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  const k = { key: "k", shift: false, alt: false, ctrl: false, meta: true };
  const t = { ...k, key: "t" }; // the command bar's default
  const c = { ...k, key: "c" }; // reserved
  old.settings.shortcuts = JSON.parse(`{"toString":${JSON.stringify(k)},"agent":${JSON.stringify(t)},"history":${JSON.stringify(c)},"settings":${JSON.stringify(k)}}`);
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.shortcuts).toEqual({ settings: k });
});

test("shortcuts: a swap of saved overrides survives a restart", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  const k = { key: "k", shift: false, alt: false, ctrl: false, meta: true };
  const j = { ...k, key: "j" }; // the agent's default, freed by its own override
  old.settings.shortcuts = { agent: k, command: j };
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.shortcuts).toEqual({ agent: k, command: j });
});

test("vimMode: missing or malformed loads off, true is kept", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  delete old.settings.vimMode;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.vimMode).toBe(false);
  old.settings.vimMode = true;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.vimMode).toBe(true);
});

test("existing session never welcomes", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  delete old.settings.onboarded;
  delete old.settings.hints;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  const s = await loadSession(d);
  expect(s.settings.onboarded).toBe(true);
  // They already use the agent, design mode and actions: those notes are seen, the tips are not.
  expect(s.settings.hints).toEqual({ enabled: true, seen: ["agent", "design", "actions"] });
});

test("an unknown hint id is dropped, the rest kept", async () => {
  const d = folder();
  const s = initialState();
  s.settings.hints = { enabled: false, seen: ["cmd-t", "from-the-future", "agent"] as never };
  writeFileSync(join(d, "session.json"), JSON.stringify(s));
  expect((await loadSession(d)).settings.hints).toEqual({ enabled: false, seen: ["cmd-t", "agent"] });
});

test("set-aside session never welcomes", async () => {
  const d = folder();
  writeFileSync(join(d, "session.json"), "{");
  expect((await loadSession(d)).settings.onboarded).toBe(true);
});

test("hints round-trip", async () => {
  const d = folder();
  const s = initialState();
  s.settings.hints = { enabled: false, seen: ["cmd-t", "agent"] };
  writeFileSync(join(d, "session.json"), JSON.stringify(s));
  expect((await loadSession(d)).settings.hints).toEqual({ enabled: false, seen: ["cmd-t", "agent"] });
});

test("a session saved without claudeEngine loads with the default; a corrupt one too, keeping the other settings", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  delete old.settings.claudeEngine;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.claudeEngine).toEqual(DEFAULT_CLAUDE_ENGINE);
  old.settings.claudeEngine = { kind: "x" };
  old.settings.agentPanelWidth = 500;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  const s = await loadSession(d);
  expect(s.settings.claudeEngine).toEqual(DEFAULT_CLAUDE_ENGINE);
  expect(s.settings.agentPanelWidth).toBe(500);
});

test("a persisted tab with a profile reloads with it", async () => {
  const d = folder();
  let n = 200;
  const g = () => `k${++n}`;
  const start = initialState(g);
  const state = apply(start, { type: "openTab", windowId: start.windows[0]!.id, url: "https://a.test/", profile: "agent" }, g);
  const recorder = new SessionRecorder(d);
  recorder.schedule(state);
  await recorder.clear();
  expect(Object.values((await loadSession(d)).tabs).some((t) => t.profile === "agent")).toBe(true);
});

test("startOnHome: each window loads on the home page, its tabs kept; off, on the tab it was left on; missing, on", async () => {
  const d = folder();
  const base = initialState();
  const saved = apply(base, { type: "openTab", windowId: base.windows[0]!.id, url: "https://a.test/" });
  const f = saved.windows[0]!;
  const tab = f.active[f.activeSpace]!;
  expect(tab).toBeTruthy();
  writeFileSync(join(d, "session.json"), JSON.stringify(saved));
  let s = await loadSession(d);
  expect(s.windows[0]!.active[f.activeSpace]).toBeNull();
  expect(s.windows[0]!.order[f.activeSpace]).toEqual([tab]);
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...saved, settings: { ...saved.settings, startOnHome: false } }));
  s = await loadSession(d);
  expect(s.windows[0]!.active[f.activeSpace]).toBe(tab);
  const { startOnHome: _, ...old } = saved.settings;
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...saved, settings: old }));
  expect((await loadSession(d)).settings.startOnHome).toBe(true);
});

test("auraMotion: off kept; missing, on", async () => {
  const d = folder();
  const saved = initialState();
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...saved, settings: { ...saved.settings, auraMotion: false } }));
  expect((await loadSession(d)).settings.auraMotion).toBe(false);
  const { auraMotion: _, ...old } = saved.settings;
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...saved, settings: old }));
  expect((await loadSession(d)).settings.auraMotion).toBe(true);
});

test("appearance: kept; missing or unknown, like the Mac", async () => {
  const d = folder();
  const saved = initialState();
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...saved, settings: { ...saved.settings, appearance: "dark" } }));
  expect((await loadSession(d)).settings.appearance).toBe("dark");
  const { appearance: _, ...old } = saved.settings;
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...saved, settings: old }));
  expect((await loadSession(d)).settings.appearance).toBe("system");
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...saved, settings: { ...saved.settings, appearance: "sepia" } }));
  expect((await loadSession(d)).settings.appearance).toBe("system");
});

test("the recorder does not rewrite a session whose saved text is unchanged (only update or locale moved)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ressac-rec-"));
  const file = join(dir, "session.json");
  const s = initialState();
  const first = new SessionRecorder(dir, 0);
  first.schedule(s);
  await first.clear();
  utimesSync(file, 1000, 1000);
  const r = new SessionRecorder(dir, 0);
  r.schedule({ ...s, locale: "fr" });
  await r.clear();
  expect(statSync(file).mtimeMs).toBe(1_000_000);
  r.schedule(apply(s, { type: "chooseLanguage", language: "en" }));
  await r.clear();
  expect(statSync(file).mtimeMs).not.toBe(1_000_000);
});

test("agentDomains: missing or malformed loads empty, invalid entries are dropped", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  delete old.settings.agentDomains;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.agentDomains).toEqual([]);
  old.settings.agentDomains = "x";
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.agentDomains).toEqual([]);
  old.settings.agentDomains = ["a.com", "Bad.com", 3, "*.b.org"];
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  expect((await loadSession(d)).settings.agentDomains).toEqual(["a.com", "*.b.org"]);
});

test("agentDomains: duplicates are removed and the list is capped at 100", async () => {
  const d = folder();
  const old = structuredClone(initialState()) as unknown as { settings: Record<string, unknown> };
  old.settings.agentDomains = ["a.com", "a.com", ...Array.from({ length: 150 }, (_, i) => `d${i}.com`)];
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  const got = (await loadSession(d)).settings.agentDomains;
  expect(got).toHaveLength(100);
  expect(got.slice(0, 2)).toEqual(["a.com", "d0.com"]);
});

test("a damaged tab or favorite is dropped alone: spaces, settings and the other tabs stay", async () => {
  const d = folder();
  const state = richState();
  const recorder = new SessionRecorder(d);
  recorder.schedule(state);
  await recorder.clear();
  const saved = JSON.parse(readFileSync(join(d, "session.json"), "utf8"));
  const [a, b] = Object.keys(state.tabs);
  // a: a field written by a later version in a wrong shape; b's pinned favorite: no url.
  saved.tabs[a!].title = 5;
  const space = saved.spaces.find((e: { pinned: unknown[] }) => e.pinned.length);
  delete space.pinned[0].url;
  writeFileSync(join(d, "session.json"), JSON.stringify(saved));
  const loaded = await loadSession(d);
  expect(set_aside(d, ".corrupt")).toEqual([]);
  expect(Object.keys(loaded.tabs)).toEqual([b]);
  expect(loaded.tabs[b!]!.link).toBeNull();
  expect(loaded.spaces.map((e) => e.name)).toEqual(state.spaces.map((e) => e.name));
  expect(loaded.spaces.flatMap((e) => e.pinned)).toEqual([]);
  const w = loaded.windows[0]!;
  expect(Object.values(w.order).flat()).not.toContain(a);
  expect(Object.values(w.active)).not.toContain(a);
  expect(loaded.settings.startOnHome).toBe(false);
});

test("an icon saved over 16 KB loads as none; a small one is kept", async () => {
  const d = folder();
  const state = richState();
  const [a, b] = Object.keys(state.tabs);
  state.tabs[a!]!.favicon = "data:image/png;base64," + "A".repeat(20_000);
  state.tabs[b!]!.favicon = "data:image/png;base64,AAAA";
  const recorder = new SessionRecorder(d);
  recorder.schedule(state);
  await recorder.clear();
  const loaded = await loadSession(d);
  expect([loaded.tabs[a!]!.favicon, loaded.tabs[b!]!.favicon]).toEqual([null, "data:image/png;base64,AAAA"]);
});

test("a corrupt session that cannot be renamed aside is copied aside; if even that fails, it starts empty and leaves the file", async () => {
  const d = folder();
  writeFileSync(join(d, "session.json"), "{ abîmé");
  const spy = vi.spyOn(fsp, "rename").mockRejectedValue(new Error("EBUSY"));
  try {
    await loadSession(d);
    expect(set_aside(d, ".corrupt").map((f) => readFileSync(join(d, f), "utf8"))).toEqual(["{ abîmé"]);
    vi.spyOn(fsp, "writeFile").mockRejectedValueOnce(new Error("EROFS"));
    rmSync(join(d, set_aside(d, ".corrupt")[0]!));
    expect((await loadSession(d)).settings.onboarded).toBe(true);
    expect(readFileSync(join(d, "session.json"), "utf8")).toBe("{ abîmé");
  } finally {
    vi.restoreAllMocks();
  }
});

test("a title-only change is saved on the slow timer; a real change brings it forward", async () => {
  expect(lazySave({ type: "updateTab", id: "t", fields: { title: "(3) Inbox" } })).toBe(true);
  expect(lazySave({ type: "updateTab", id: "t", fields: { url: "https://a.example/", title: "A" } })).toBe(false);
  expect(lazySave({ type: "closeTab", id: "t" })).toBe(false);
  const d = folder();
  const recorder = new SessionRecorder(d, 20, 400);
  recorder.schedule(richState(), true);
  await wait(150);
  expect(existsSync(join(d, "session.json"))).toBe(false);
  recorder.schedule(richState());
  await wait(150);
  expect(readFileSync(join(d, "session.json"), "utf8")).not.toContain("\n");
});
