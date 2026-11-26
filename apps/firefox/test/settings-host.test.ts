import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWN_KEY, keychain } from "../host/keychain";
import { createSettingsHandlers } from "../host/settings";
import type { AiState } from "../../../packages/kernel/src/index";
import type { MachineStatus } from "../shared/settings";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(over: { state?: string; started?: string; exec?: (argv: string[]) => unknown; installed?: string[] } = {}) {
  const pids = join(mkdtempSync(join(tmpdir(), "settings-pids-")), "pids");
  dirs.push(join(pids, ".."));
  const dataDir = mkdtempSync(join(tmpdir(), "settings-host-"));
  dirs.push(dataDir);
  const calls: string[] = [];
  const exec = vi.fn(over.exec ?? (async () => ({ code: 0, stdout: '{"loggedIn":true,"email":"ami@example.com"}', stderr: "" })));
  const o = {
    workshop: {
      state: async () => (over.state ?? "started") as any,
      exec: exec as any,
      restart: vi.fn(async () => (calls.push("restart"), "started" as const)),
      rebuild: vi.fn(async () => (calls.push("rebuild"), "started" as const)),
      secureNetwork: vi.fn(async () => void calls.push("secureNetwork")),
      ensureStarted: vi.fn(async () => (calls.push("ensureStarted"), (over.started ?? "started") as any)),
    },
    ai: {
      check: async () => ({ embed: true }),
      cancelInstall: vi.fn(),
      embed: { state: vi.fn((): { state: AiState; error?: string } => ({ state: "stopped" })), install: vi.fn(async (onPercent: (p: number | null) => void): Promise<void> => (onPercent(60), void calls.push("embed.install"))) },
    },
    docker: { status: async () => ({ kind: "stopped", app: "OrbStack" }) as const, start: vi.fn(async () => void calls.push("docker.start")) },
    machine: {
      status: vi.fn((): MachineStatus => ({ kind: "running" })),
      usage: async () => ({ memoryMB: 614, diskMB: 1843 }),
      install: vi.fn(async () => void calls.push("machine.install")),
      remove: vi.fn(async (r?: { force?: boolean }) => void calls.push(r?.force ? "machine.remove --force" : "machine.remove")),
      waiting: vi.fn(() => false),
      switchNow: vi.fn(async () => void calls.push("machine.switchNow")),
    },
    stopApps: vi.fn(async () => void calls.push("stopApps")),
    relaunchSessions: vi.fn(async () => void calls.push("relaunch")),
    dataDir,
    widgetsFolder: join(dataDir, "widgets"),
    actionsFolder: join(dataDir, "actions"),
    names: async (k: string): Promise<Record<string, string>> => (k === "widget" ? { meteo: "Météo" } : k === "action" ? { lire: "Lire" } : { yt: "YouTube" }),
    denyWidget: vi.fn(async () => {}),
    denyAction: vi.fn(async () => {}),
    revokeSite: vi.fn(async () => {}),
    // A fake CLI that prints a code then waits.
    deviceCommand: vi.fn((argv: string[]) => {
      void argv;
      return [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");console.log("https://auth.openai.com/codex/device B3MH-2FT21");setTimeout(()=>{},60000)`];
    }),
    keychain: { read: vi.fn(async () => null), has: vi.fn(async () => true), write: vi.fn(async (k: string) => void (k.includes(" ") && (() => { throw new Error("Clé invalide : x"); })())), remove: vi.fn(async () => {}), origin: vi.fn(async () => null) },
    claudeKeychain: { read: vi.fn(async () => null), has: vi.fn(async () => false), write: vi.fn(async () => {}), remove: vi.fn(async () => {}), origin: vi.fn(async () => null) },
    ownKeychain: keychain({ ...OWN_KEY, env: { RESSAC_TEST_KEYCHAIN: join(dataDir, "kc") } }),
    forgetKey: vi.fn(),
    writer: { via: vi.fn(async () => ({ agent: "claude" as const, via: "subscription" as const })), reset: vi.fn() },
    cli: { installed: vi.fn(async (a: string) => (over.installed ?? ["claude", "codex"]).includes(a)), ensure: vi.fn(async (_a: string) => {}) },
    notify: vi.fn(),
  };
  const alive = () => readFileSync(pids, "utf8").trim().split("\n").map((p) => { try { process.kill(Number(p), 0); return true; } catch { return false; } });
  return { o, exec, calls, alive, h: createSettingsHandlers(o) };
}

describe("settings host", () => {
  it("docker absent", async () => {
    const { h, exec, o } = setup({ state: "docker-absent" });
    expect(await h["settings.agents"]!({})).toEqual([
      { id: "claude", name: "Claude Code", state: "docker-absent", login: "terminal" },
      { id: "codex", name: "Codex", state: "docker-absent", login: "device" },
    ]);
    expect(exec).not.toHaveBeenCalled();
    expect(await h["settings.login"]!({ id: "codex" })).toMatchObject({ kind: "error" });
    expect(o.deviceCommand).not.toHaveBeenCalled();
  });

  it("the workshop machine: status, usage, retry, and a removal that stops the apps first; force only when asked and offered", async () => {
    const { h, o, calls } = setup();
    expect(await h["settings.machine"]!({})).toEqual({ kind: "running" });
    expect(await h["settings.machineUsage"]!({})).toEqual({ memoryMB: 614, diskMB: 1843 });
    expect(await h["settings.machineInstall"]!({})).toEqual({ ok: true });
    expect(await h["settings.machineRemove"]!({})).toEqual({ ok: true });
    expect(await h["settings.machineRemove"]!({ force: "yes" })).toEqual({ ok: true });
    // A running machine: a forced removal is not offered, so a normal one runs (its logins exported).
    expect(await h["settings.machineRemove"]!({ force: true })).toEqual({ ok: true });
    o.machine.status.mockReturnValue({ kind: "error", message: "damaged", forceRemovable: true });
    expect(await h["settings.machineRemove"]!({ force: true })).toEqual({ ok: true });
    expect(calls).toEqual(["machine.install", "stopApps", "machine.remove", "stopApps", "machine.remove", "stopApps", "machine.remove", "stopApps", "machine.remove --force"]);
    o.machine.remove.mockRejectedValueOnce(new Error("kept"));
    expect(await h["settings.machineRemove"]!({})).toEqual({ ok: false, error: "kept" });
    o.machine.install.mockRejectedValueOnce(new Error("no download"));
    expect(await h["settings.machineInstall"]!({})).toEqual({ ok: false, error: "no download" });
  });

  it("a hand-over waiting for Docker's sessions shows, and « Passer maintenant » stops the apps, switches, relaunches the sessions", async () => {
    const { h, o, calls } = setup();
    expect(await h["settings.machineSwitchNow"]!({})).toEqual({ ok: true });
    expect(calls).toEqual([]); // nothing waits: nothing done
    o.machine.waiting.mockReturnValue(true);
    expect(await h["settings.machine"]!({})).toEqual({ kind: "running", waiting: true });
    expect(await h["settings.machineSwitchNow"]!({})).toEqual({ ok: true });
    await vi.waitFor(() => expect(calls).toEqual(["stopApps", "machine.switchNow", "relaunch"]));
    o.machine.switchNow.mockRejectedValueOnce(new Error("docker stop: no"));
    expect(await h["settings.machineSwitchNow"]!({})).toEqual({ ok: false, error: "docker stop: no" });
  });

  it("container stopped", async () => {
    const { h } = setup({ state: "stopped" });
    expect(await h["settings.agents"]!({})).toEqual([
      { id: "claude", name: "Claude Code", state: "no-container", login: "terminal" },
      { id: "codex", name: "Codex", state: "no-container", login: "device" },
    ]);
  });

  it("logged in, out and error", async () => {
    const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "boom" });
    let r = out('{"loggedIn":true,"email":"ami@example.com"}');
    const { h } = setup({ exec: async () => r });
    expect((await h["settings.agents"]!({}) as any[])[0]).toMatchObject({ state: "logged-in", account: "ami@example.com" });
    r = out('{"loggedIn":false}');
    expect((await h["settings.agents"]!({}) as any[])[0]).toMatchObject({ state: "logged-out" });
    // The real CLI exits 1 when logged out, with its JSON on stdout.
    r = out('{"loggedIn":false,"authMethod":"none"}', 1);
    expect((await h["settings.agents"]!({}) as any[])[0]).toMatchObject({ state: "logged-out" });
    r = out("", 1);
    expect((await h["settings.agents"]!({}) as any[])[0]).toMatchObject({ state: "error", error: "boom" });
    r = out("not json");
    expect((await h["settings.agents"]!({}) as any[])[0]).toMatchObject({ state: "error" });
  });

  it("ollamaModels: a non-string address is refused without any request", async () => {
    const { h } = setup();
    expect(await h["settings.ollamaModels"]!({ url: 3 })).toEqual({ ok: false, error: "Adresse invalide" });
    expect(await h["settings.ollamaModels"]!({})).toEqual({ ok: false, error: "Adresse invalide" });
  });

  it("logout touches nothing else", async () => {
    const { h, exec, o } = setup();
    await h["settings.logout"]!({ id: "claude" });
    expect(exec).toHaveBeenNthCalledWith(1, ["claude", "auth", "logout"]);
    expect(exec).toHaveBeenCalledTimes(3); // the logout, then one status per account
    expect(o.relaunchSessions).not.toHaveBeenCalled();
    expect(o.stopApps).not.toHaveBeenCalled();
    exec.mockClear();
    await h["settings.logout"]!({ id: "nope" });
    expect(exec).toHaveBeenCalledTimes(2); // only the status re-reads
    expect(exec).not.toHaveBeenCalledWith(["claude", "auth", "logout"]);
  });

  it("logout of a CLI not downloaded execs nothing (the image carries none)", async () => {
    const { h, exec } = setup({ installed: ["codex"] });
    await h["settings.logout"]!({ id: "claude" });
    expect(exec).not.toHaveBeenCalledWith(["claude", "auth", "logout"]);
  });

  it("codex states", async () => {
    let r = { code: 0, stdout: "", stderr: "Logged in using ChatGPT" };
    const { h } = setup({ exec: async (argv) => (argv[0] === "codex" ? r : { code: 0, stdout: '{"loggedIn":false}', stderr: "" }) });
    const codex = async () => ((await h["settings.agents"]!({})) as any[])[1];
    expect(await codex()).toEqual({ id: "codex", name: "Codex", state: "logged-in", account: "ChatGPT", login: "device" });
    r = { code: 0, stdout: "", stderr: "API key configured - sk-***" };
    expect(await codex()).toMatchObject({ state: "logged-in", account: "clé d'API" });
    r = { code: 1, stdout: "", stderr: "Not logged in" };
    expect(await codex()).toMatchObject({ state: "logged-out" });
    r = { code: 2, stdout: "", stderr: "what?" };
    expect(await codex()).toMatchObject({ state: "error", error: "what?" });
  });

  it("one login at a time", async () => {
    const { h, alive, o } = setup();
    expect(await h["settings.login"]!({ id: "claude" })).toEqual({ kind: "terminal" });
    expect(await h["settings.login"]!({ id: "codex" })).toEqual({ kind: "device", url: "https://auth.openai.com/codex/device", code: "B3MH-2FT21" });
    expect(await h["settings.login"]!({ id: "codex" })).toMatchObject({ kind: "device" });
    await vi.waitFor(() => expect(alive()).toEqual([false, true]));
    h.stopLogins();
    await vi.waitFor(() => expect(alive()).toEqual([false, false]));
    expect(o.deviceCommand).toHaveBeenCalledWith(["codex", "login", "--device-auth"]);
    expect(o.workshop.secureNetwork).toHaveBeenCalled();
  });

  it("an agent whose CLI is not downloaded shows so without an exec; its sign-in downloads it first", async () => {
    const { h, exec, o } = setup({ installed: ["claude"] });
    expect(await h["settings.agents"]!({})).toEqual([
      { id: "claude", name: "Claude Code", state: "logged-in", account: "ami@example.com", login: "terminal" },
      { id: "codex", name: "Codex", state: "not-downloaded", login: "device" },
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(["claude", "auth", "status", "--json"]);
    expect(await h["settings.login"]!({ id: "codex" })).toMatchObject({ kind: "device" });
    expect(o.cli.ensure).toHaveBeenCalledWith("codex");
    expect(o.cli.ensure.mock.invocationCallOrder[0]).toBeLessThan(o.workshop.secureNetwork.mock.invocationCallOrder[0]!);
    h.stopLogins();
  });

  it("loginEnded waits for a sign-in by code still running, so the sweep never kills it", async () => {
    const { h } = setup();
    await h.loginEnded();
    expect(await h["settings.login"]!({ id: "codex" })).toMatchObject({ kind: "device" });
    let ended = false;
    void h.loginEnded().then(() => (ended = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(ended).toBe(false);
    h.stopLogins();
    await vi.waitFor(() => expect(ended).toBe(true));
  });

  it("loginEnded waits at most maxMs, then ends a sign-in that never finishes", async () => {
    const { h, alive } = setup({ exec: async (argv: string[]) => ({ code: 1, stdout: argv[0] === "codex" ? "Not logged in" : '{"loggedIn":false}', stderr: "" }) });
    expect(await h["settings.login"]!({ id: "codex" })).toMatchObject({ kind: "device" });
    await vi.waitFor(() => expect(alive()).toEqual([true]));
    const codex = async () => ((await h["settings.agents"]!({})) as any[]).find((x) => x.id === "codex");
    expect(await codex()).toMatchObject({ signingIn: true });
    await h.loginEnded(100);
    await vi.waitFor(() => expect(alive()).toEqual([false]));
    // Réglages reads that it ended: the code gives way to « interrompue » and Se connecter.
    await vi.waitFor(async () => expect((await codex()).signingIn).toBeUndefined());
  });

  it("a status check that fails during a sign-in by code keeps signingIn: the code stays shown", async () => {
    const { h, o } = setup({ exec: async () => ({ code: 2, stdout: "", stderr: "docker hiccup" }) });
    expect(await h["settings.login"]!({ id: "codex" })).toMatchObject({ kind: "device" });
    const codex = ((await h["settings.agents"]!({})) as any[]).find((x) => x.id === "codex");
    expect(codex).toMatchObject({ state: "error", signingIn: true });
    o.workshop.state = async () => "docker-absent" as any;
    expect(((await h["settings.agents"]!({})) as any[]).find((x) => x.id === "codex")).toMatchObject({ state: "docker-absent", signingIn: true });
    h.stopLogins();
  });

  it("login refused while the agent's network cannot be secured: the CLI never runs", async () => {
    const { h, o } = setup();
    o.workshop.secureNetwork.mockRejectedValueOnce(new Error("no rules"));
    expect(await h["settings.login"]!({ id: "codex" })).toMatchObject({ kind: "error" });
    expect(o.deviceCommand).not.toHaveBeenCalled();
  });

  it("login needs a running workshop", async () => {
    const { h, o } = setup({ state: "stopped" });
    expect(await h["settings.login"]!({ id: "codex" })).toEqual({ kind: "error", error: "L'atelier de l'agent n'est pas démarré : voir Atelier." });
    expect(o.deviceCommand).not.toHaveBeenCalled();
  });

  it("login on a stopped machine starts it first; one that stays stopped is refused", async () => {
    const { h, calls } = setup({ state: "machine-stopped" });
    expect(await h["settings.login"]!({ id: "codex" })).toMatchObject({ kind: "device" });
    expect(calls.slice(0, 2)).toEqual(["ensureStarted", "secureNetwork"]);
    h.stopLogins();
    const still = setup({ state: "machine-stopped", started: "machine-stopped" });
    expect(await still.h["settings.login"]!({ id: "codex" })).toEqual({ kind: "error", error: "L'atelier de l'agent n'est pas démarré : voir Atelier." });
    expect(still.o.deviceCommand).not.toHaveBeenCalled();
  });

  it("login waits at most a minute for a machine that is still starting (a first image build), then says it is not started", async () => {
    const { h, o } = setup({ state: "machine-stopped" });
    o.workshop.ensureStarted.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const answer = h["settings.login"]!({ id: "codex" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await answer).toEqual({ kind: "error", error: "L'atelier de l'agent n'est pas démarré : voir Atelier." });
      expect(o.deviceCommand).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("login on a machine the user removed says how to install it again, never « non démarré »", async () => {
    const { h, o } = setup({ state: "machine-stopped", started: "machine-stopped" });
    o.machine.status.mockReturnValue({ kind: "absent", removed: true });
    expect(await h["settings.login"]!({ id: "codex" })).toEqual({ kind: "error", error: "La machine de l'atelier a été supprimée : installez-la dans Réglages › Atelier (« Installer la machine »)." });
    expect(o.deviceCommand).not.toHaveBeenCalled();
  });

  it("logout codex", async () => {
    const { h, exec, o } = setup();
    await h["settings.logout"]!({ id: "codex" });
    expect(exec).toHaveBeenNthCalledWith(1, ["codex", "logout"]);
    expect(o.relaunchSessions).not.toHaveBeenCalled();
  });

  it("key", async () => {
    const { h, o } = setup();
    expect(await h["settings.codexKey"]!({ key: "sk-1" })).toEqual({ ok: true });
    expect(o.keychain.write).toHaveBeenCalledWith("sk-1");
    expect(o.forgetKey).toHaveBeenCalledTimes(1);
    expect(await h["settings.codexKey"]!({ key: "a b" })).toEqual({ ok: false, error: "Clé invalide : x" });
    expect(o.forgetKey).toHaveBeenCalledTimes(1);
    for (const bad of [undefined, 42, null]) expect(await h["settings.codexKey"]!({ key: bad })).toMatchObject({ ok: false, error: expect.stringContaining("Clé invalide") });
    expect(o.keychain.write).toHaveBeenCalledTimes(2); // sk-1 and "a b" only
    expect(await h["settings.codexKeySaved"]!({})).toBe(true);
    expect(await h["settings.codexKeyDelete"]!({})).toEqual({ ok: true });
    expect(o.keychain.remove).toHaveBeenCalled();
    expect(o.forgetKey).toHaveBeenCalledTimes(2);
    expect(o.forgetKey).toHaveBeenLastCalledWith("codex");
  });

  it("Claude's key: its own keychain, its own cache", async () => {
    const { h, o } = setup();
    expect(await h["settings.claudeKey"]!({ key: "sk-ant" })).toEqual({ ok: true });
    expect(o.claudeKeychain.write).toHaveBeenCalledWith("sk-ant");
    expect(o.keychain.write).not.toHaveBeenCalled();
    expect(o.forgetKey).toHaveBeenLastCalledWith("claude");
    expect(await h["settings.claudeKey"]!({ key: 42 })).toMatchObject({ ok: false, error: expect.stringContaining("Clé invalide") });
    expect(await h["settings.claudeKeySaved"]!({})).toBe(false);
    expect(await h["settings.claudeKeyDelete"]!({})).toEqual({ ok: true });
    expect(o.claudeKeychain.remove).toHaveBeenCalled();
    expect(o.forgetKey).toHaveBeenCalledTimes(2);
  });

  it("own key is written to its own Keychain item and never returned", async () => {
    const { h, o } = setup();
    const results = [await h["settings.ownKeySaved"]!({}), await h["settings.ownKey"]!({ key: "sk-own", url: "https://api.example.com/v1" }), await h["settings.ownKeySaved"]!({})];
    expect(results).toEqual([false, { ok: true }, true]);
    expect(readFileSync(join(o.dataDir, "kc.own"), "utf8")).toBe("sk-own");
    expect(readFileSync(join(o.dataDir, "kc.own.origin"), "utf8")).toBe("https://api.example.com");
    expect(await h["settings.ownKey"]!({ key: "sk-x", url: "http://192.168.1.4/v1" })).toEqual({ ok: false, error: "Adresse invalide (https://…)" });
    expect(o.forgetKey).toHaveBeenLastCalledWith("own");
    expect(await h["settings.ownKey"]!({ key: 42 })).toMatchObject({ ok: false, error: expect.stringContaining("Clé invalide") });
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_u: string, i: RequestInit) => (seen.push(i), new Response(JSON.stringify({ data: [{ id: "m" }] }))));
    try {
      results.push(await h["settings.ownModels"]!({ url: "https://api.example.com/v1" }));
      results.push(await h["settings.ownModels"]!({ url: "http://192.168.1.4/v1" }));
      results.push(await h["settings.ownModels"]!({ url: "https://typo.example.com/v1" }));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(results.slice(3)).toEqual([
      { ok: true, models: ["m"] },
      { ok: false, error: "Adresse invalide (https://…)" },
      { ok: true, models: ["m"], keyNotSent: expect.stringContaining("n'est pas envoyée à typo.example.com") },
    ]);
    expect(seen.length).toBe(2);
    expect((seen[0]!.headers as Record<string, string>).authorization).toBe("Bearer sk-own");
    expect(seen[1]!.headers).toEqual({});
    results.push(await h["settings.ownKeyDelete"]!({}), await h["settings.ownKeySaved"]!({}));
    expect(results.at(-1)).toBe(false);
    expect(o.keychain.write).not.toHaveBeenCalled();
    expect(JSON.stringify(results)).not.toContain("sk-own");
  });

  it("rebuild order", async () => {
    const { h, calls, o } = setup();
    expect(await h["settings.restartWorkshop"]!({ fresh: true })).toEqual({ ok: true });
    expect(calls).toEqual(["stopApps", "rebuild", "relaunch"]);
    calls.length = 0;
    await h["settings.restartWorkshop"]!({ fresh: false });
    expect(calls).toEqual(["stopApps", "restart", "relaunch"]);
    o.workshop.rebuild.mockRejectedValueOnce(new Error("kaput"));
    expect(await h["settings.restartWorkshop"]!({ fresh: true })).toEqual({ ok: false, error: "kaput" });
  });

  it("one workshop operation at a time", async () => {
    const { h, calls, o } = setup();
    let finish!: () => void;
    o.workshop.rebuild.mockImplementationOnce(() => new Promise((r) => (finish = () => r((calls.push("rebuild"), "started")))));
    const first = h["settings.restartWorkshop"]!({ fresh: true }) as Promise<unknown>;
    await vi.waitFor(() => expect(o.workshop.rebuild).toHaveBeenCalled());
    expect(await h["settings.workshopOperation"]!({})).toBe("rebuild");
    expect(await h["settings.restartWorkshop"]!({ fresh: false })).toEqual({ ok: false, error: "Une opération sur l'atelier est déjà en cours." });
    finish();
    expect(await first).toEqual({ ok: true });
    expect(calls).toEqual(["stopApps", "rebuild", "relaunch"]);
    expect(await h["settings.workshopOperation"]!({})).toBeNull();
  });

  it("grants", async () => {
    const { h, o } = setup();
    const g = (profile: string) => ({ domains: ["mail.fr"], public: [], profile });
    mkdirSync(o.widgetsFolder, { recursive: true });
    mkdirSync(o.actionsFolder, { recursive: true });
    writeFileSync(join(o.widgetsFolder, "grants.json"), JSON.stringify({ meteo: g("default") }));
    writeFileSync(join(o.actionsFolder, "grants.json"), JSON.stringify({ lire: g("work") }));
    writeFileSync(join(o.dataDir, "site-grants.json"), JSON.stringify({ yt: { domains: ["youtube.com"], login: [], frames: [], resume: false } }));
    expect(await h["settings.grants"]!({})).toEqual([
      { kind: "widget", key: "meteo", name: "Météo", profile: "default", detail: "Lit avec votre compte : mail.fr" },
      { kind: "action", key: "lire", name: "Lire", profile: "work", detail: "Lit avec votre compte : mail.fr" },
      { kind: "siteApp", key: "yt", name: "YouTube", profile: null, detail: "Retouches et lecture de l'appli accordées" },
    ]);
  });

  it("revoke routing", async () => {
    const { h, o } = setup();
    await h["settings.revoke"]!({ kind: "widget", key: "meteo" });
    await h["settings.revoke"]!({ kind: "action", key: "lire" });
    await h["settings.revoke"]!({ kind: "siteApp", key: "yt" });
    expect([o.denyWidget, o.denyAction, o.revokeSite].map((f) => f.mock.calls)).toEqual([[["meteo"]], [["lire"]], [["yt"]]]);
    await h["settings.revoke"]!({ kind: "widget", key: "../x" });
    await h["settings.revoke"]!({ kind: "site", key: "meteo" });
    expect(o.denyWidget).toHaveBeenCalledTimes(1);
    expect(o.revokeSite).toHaveBeenCalledTimes(1);
  });

  it("pullModel: only the search model, progress visible meanwhile, errors returned", async () => {
    const { h, o } = setup();
    for (const name of ["llama3", "gemma4:e4b-mlx", "ollama", "d1-2B", "pplx-decider-flash"]) expect(await h["settings.pullModel"]!({ name })).toEqual({ ok: false, error: "Modèle non pris en charge" });
    let finish!: () => void;
    o.ai.embed.install.mockImplementationOnce((onPercent) => new Promise<void>((ok) => (onPercent(50), (finish = ok))));
    const first = h["settings.pullModel"]!({ name: "embeddinggemma-300m" }) as Promise<unknown>;
    await vi.waitFor(async () => expect(await h["settings.pullProgress"]!({})).toEqual({ name: "embeddinggemma-300m", status: "", percent: 50 }));
    finish();
    expect(await first).toEqual({ ok: true });
    expect(await h["settings.pullProgress"]!({})).toBeNull();
    o.ai.embed.install.mockRejectedValueOnce(new Error("no space"));
    expect(await h["settings.pullModel"]!({ name: "embeddinggemma-300m" })).toEqual({ ok: false, error: "no space" });
  });

  it("pullInBackground: answers at once, notifies the end or the failure; Gemma, Ollama and d1 are refused", async () => {
    const { h, o, calls } = setup();
    expect(await h["settings.pullInBackground"]!({ names: ["gemma4:e4b-mlx"] })).toEqual({ ok: false, error: "Modèle non pris en charge" });
    expect(await h["settings.pullInBackground"]!({ names: ["ollama", "embeddinggemma-300m"] })).toEqual({ ok: false, error: "Modèle non pris en charge" });
    expect(await h["settings.pullInBackground"]!({ names: ["d1-2B"] })).toEqual({ ok: false, error: "Modèle non pris en charge" });
    expect(await h["settings.pullInBackground"]!({ names: [] })).toMatchObject({ ok: false });
    expect(await h["settings.pullInBackground"]!({ names: ["embeddinggemma-300m"] })).toEqual({ ok: true });
    await vi.waitFor(() => expect(o.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "L'IA locale est prête" })));
    expect(calls).toEqual(["embed.install"]);
    expect(await h["settings.pullProgress"]!({})).toBeNull();
    o.ai.embed.install.mockRejectedValueOnce(new Error("no space"));
    expect(await h["settings.pullInBackground"]!({ names: ["embeddinggemma-300m"] })).toEqual({ ok: true });
    await vi.waitFor(() => expect(o.notify).toHaveBeenLastCalledWith({ title: "Le téléchargement de l'IA locale a échoué", text: "no space. Réessayez depuis Réglages › IA locale." }));
  });

  it("Docker: its status and its start", async () => {
    const { h, calls } = setup();
    expect(await h["settings.docker"]!({})).toEqual({ kind: "stopped", app: "OrbStack" });
    expect(await h["settings.startDocker"]!({})).toEqual({ ok: true });
    expect(calls).toEqual(["docker.start"]);
  });

  it("ai.state", async () => {
    const { h } = setup();
    expect(await h["ai.state"]!({})).toEqual({ state: "stopped", verification: { embed: true } });
  });

  it("ai.state: the search server's start failure shows as searchServerError", async () => {
    const { h, o } = setup();
    expect(await h["ai.state"]!({})).not.toHaveProperty("searchServerError");
    o.ai.embed.state.mockReturnValue({ state: "error", error: "llama-server did not start" });
    expect(await h["ai.state"]!({})).toMatchObject({ searchServerError: "llama-server did not start" });
  });

  it("a failed search download stays in ai.state as searchError until a later success; no decision error exists", async () => {
    const { h, o } = setup();
    o.ai.embed.install.mockImplementationOnce(async () => {
      throw new Error("HTTP 503");
    });
    h.downloadModels(["embeddinggemma-300m"]);
    await vi.waitFor(async () => expect(await h["ai.state"]!({})).toMatchObject({ searchError: "HTTP 503" }));
    expect(await h["ai.state"]!({})).not.toHaveProperty("decisionError");
    expect(await h["settings.pullModel"]!({ name: "embeddinggemma-300m" })).toEqual({ ok: true });
    expect(await h["ai.state"]!({})).not.toHaveProperty("searchError");
  });

  /** A background download held until `finish()`. */
  const held = (o: ReturnType<typeof setup>["o"], calls: string[]) => {
    let finish!: () => void;
    o.ai.embed.install.mockImplementationOnce(() => new Promise<void>((ok) => (finish = () => (calls.push("held"), ok()))));
    return () => finish();
  };
  const running = (h: ReturnType<typeof setup>["h"]) => vi.waitFor(async () => expect(await h["settings.pullProgress"]!({})).toMatchObject({ name: "embeddinggemma-300m" }));

  it("the welcome's pull queues behind the background download instead of failing busy", async () => {
    const { h, o, calls } = setup();
    const finish = held(o, calls);
    h.downloadModels(["embeddinggemma-300m"]);
    await running(h);
    expect(await h["settings.pullInBackground"]!({ names: ["embeddinggemma-300m"] })).toEqual({ ok: true });
    expect(calls).toEqual([]);
    finish();
    await vi.waitFor(() => expect(o.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "L'IA locale est prête" })));
    expect(calls).toEqual(["held", "embed.install"]);
  });

  it("two clicks on the search row during the background download wait, none is refused busy", async () => {
    const { h, o, calls } = setup();
    const finish = held(o, calls);
    h.downloadModels(["embeddinggemma-300m"]);
    await running(h);
    const two = Promise.all([h["settings.pullModel"]!({ name: "embeddinggemma-300m" }), h["settings.pullModel"]!({ name: "embeddinggemma-300m" })]);
    finish();
    expect(await two).toEqual([{ ok: true }, { ok: true }]);
  });

  it("cancels the download when AI goes off, without keeping an error", async () => {
    const { h, o } = setup();
    let fail!: (e: Error) => void;
    o.ai.embed.install.mockImplementationOnce(() => new Promise<void>((_ok, ko) => (fail = ko)));
    o.ai.cancelInstall.mockImplementation(() => fail(new Error("Installation annulée")));
    h.downloadModels(["embeddinggemma-300m"]);
    await running(h);
    h.cancelDownloads();
    expect(o.ai.cancelInstall).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect(await h["settings.pullProgress"]!({})).toBeNull());
    expect(await h["ai.state"]!({})).not.toHaveProperty("searchError");
  });

  it("pulls queued behind the background download are dropped when AI goes off meanwhile, without a failure notification", async () => {
    const { h, o } = setup();
    let fail!: (e: Error) => void;
    o.ai.embed.install.mockImplementationOnce(() => new Promise<void>((_ok, ko) => (fail = ko)));
    o.ai.cancelInstall.mockImplementation(() => fail(new Error("Installation annulée")));
    h.downloadModels(["embeddinggemma-300m"]);
    await running(h);
    const queued = h["settings.pullModel"]!({ name: "embeddinggemma-300m" });
    expect(await h["settings.pullInBackground"]!({ names: ["embeddinggemma-300m"] })).toEqual({ ok: true });
    h.cancelDownloads();
    expect(await queued).toEqual({ ok: false, error: "Installation annulée" });
    await new Promise((r) => setTimeout(r, 20));
    expect(o.ai.embed.install).toHaveBeenCalledTimes(1);
    expect(o.notify).not.toHaveBeenCalled();
  });

  it("AI off then on again while the cancelled download still ends: the new start's download runs after it", async () => {
    const { h, o, calls } = setup();
    let fail!: (e: Error) => void;
    o.ai.embed.install.mockImplementationOnce(() => new Promise<void>((_ok, ko) => (fail = ko)));
    h.downloadModels(["embeddinggemma-300m"]);
    await running(h);
    h.cancelDownloads();
    h.downloadModels(["embeddinggemma-300m"]);
    fail(new Error("Installation annulée"));
    await vi.waitFor(() => expect(calls).toEqual(["embed.install"]));
    expect(o.ai.embed.install).toHaveBeenCalledTimes(2);
  });

  it("a start queued behind a cancelled download is dropped by a second AI off", async () => {
    const { h, o } = setup();
    let fail!: (e: Error) => void;
    o.ai.embed.install.mockImplementationOnce(() => new Promise<void>((_ok, ko) => (fail = ko)));
    h.downloadModels(["embeddinggemma-300m"]);
    await running(h);
    h.cancelDownloads();
    h.downloadModels(["embeddinggemma-300m"]);
    h.cancelDownloads();
    fail(new Error("Installation annulée"));
    await new Promise((r) => setTimeout(r, 20));
    expect(o.ai.embed.install).toHaveBeenCalledTimes(1);
  });

  it("a model that finishes downloading is told to modelInstalled, a failed one is not", async () => {
    const { o } = setup();
    const installed: string[] = [];
    const h = createSettingsHandlers({ ...o, modelInstalled: (n: string) => void installed.push(n) });
    o.ai.embed.install.mockImplementationOnce(async () => {
      throw new Error("HTTP 503");
    });
    h.downloadModels(["embeddinggemma-300m"]);
    await vi.waitFor(async () => expect(await h["ai.state"]!({})).toMatchObject({ searchError: "HTTP 503" }));
    expect(installed).toEqual([]);
    h.downloadModels(["embeddinggemma-300m"]);
    await vi.waitFor(() => expect(installed).toEqual(["embeddinggemma-300m"]));
  });
});
