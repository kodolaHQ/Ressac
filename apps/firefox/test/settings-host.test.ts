import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsHandlers } from "../host/settings";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(over: { state?: string; exec?: (argv: string[]) => unknown; ollama?: unknown } = {}) {
  const pids = join(mkdtempSync(join(tmpdir(), "settings-pids-")), "pids");
  dirs.push(join(pids, ".."));
  const dataDir = mkdtempSync(join(tmpdir(), "settings-host-"));
  dirs.push(dataDir);
  const calls: string[] = [];
  const exec = vi.fn(over.exec ?? (async () => ({ code: 0, stdout: '{"loggedIn":true,"email":"ami@example.com"}', stderr: "" })));
  const o = {
    workshop: {
      state: async () => (over.state ?? "demarre") as any,
      exec: exec as any,
      restart: vi.fn(async () => (calls.push("restart"), "demarre" as const)),
      rebuild: vi.fn(async () => (calls.push("rebuild"), "demarre" as const)),
      secureNetwork: vi.fn(async () => void calls.push("secureNetwork")),
    },
    ai: {
      state: () => ({ state: "stopped" as const }),
      check: async () => ({ ollama: true, gemma: false, gemmaModel: null, decision: true }),
      ollamaUrl: "http://127.0.0.1:11434",
      installDecisionModel: vi.fn(async (onPercent: (p: number | null) => void): Promise<void> => (onPercent(30), void calls.push("installDecisionModel"))),
      cancelInstall: vi.fn(),
    },
    ollama: {
      status: async () => (over.ollama ?? { kind: "unmanaged" }) as any,
      start: vi.fn(async () => void calls.push("ollama.start")),
      install: vi.fn(async (progress: (p: number | null) => void) => (progress(40), void calls.push("ollama.install"))),
    },
    docker: { status: async () => ({ kind: "stopped", app: "OrbStack" }) as const, start: vi.fn(async () => void calls.push("docker.start")) },
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
    keychain: { read: vi.fn(async () => null), has: vi.fn(async () => true), write: vi.fn(async (k: string) => void (k.includes(" ") && (() => { throw new Error("Clé invalide : x"); })())), remove: vi.fn(async () => {}) },
    claudeKeychain: { read: vi.fn(async () => null), has: vi.fn(async () => false), write: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    amoKeychain: { issuer: vi.fn(async (): Promise<string | null> => "user:1:2"), write: vi.fn(async (i: string) => void (i === "bad" && (() => { throw new Error("Clé invalide : x"); })())), remove: vi.fn(async () => {}) },
    forgetKey: vi.fn(),
    notify: vi.fn(),
  };
  const alive = () => readFileSync(pids, "utf8").trim().split("\n").map((p) => { try { process.kill(Number(p), 0); return true; } catch { return false; } });
  return { o, exec, calls, alive, h: createSettingsHandlers(o) };
}

describe("settings host", () => {
  it("docker absent", async () => {
    const { h, exec, o } = setup({ state: "docker-absent" });
    expect(await h["settings.agents"]!({})).toEqual([
      { id: "claude", name: "Claude Code", state: "docker-absent", login: "panel" },
      { id: "codex", name: "Codex", state: "docker-absent", login: "device" },
    ]);
    expect(exec).not.toHaveBeenCalled();
    expect(await h["settings.login"]!({ id: "codex" })).toMatchObject({ kind: "error" });
    expect(o.deviceCommand).not.toHaveBeenCalled();
  });

  it("container stopped", async () => {
    const { h } = setup({ state: "arrete" });
    expect(await h["settings.agents"]!({})).toEqual([
      { id: "claude", name: "Claude Code", state: "no-container", login: "panel" },
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
    expect(await h["settings.login"]!({ id: "claude" })).toEqual({ kind: "panel" });
    expect(await h["settings.login"]!({ id: "codex" })).toEqual({ kind: "device", url: "https://auth.openai.com/codex/device", code: "B3MH-2FT21" });
    expect(await h["settings.login"]!({ id: "codex" })).toMatchObject({ kind: "device" });
    await vi.waitFor(() => expect(alive()).toEqual([false, true]));
    h.stopLogins();
    await vi.waitFor(() => expect(alive()).toEqual([false, false]));
    expect(o.deviceCommand).toHaveBeenCalledWith(["codex", "login", "--device-auth"]);
    expect(o.workshop.secureNetwork).toHaveBeenCalled();
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

  it("login on a workshop built before Codex", async () => {
    const { h, o } = setup();
    o.deviceCommand.mockReturnValueOnce([process.execPath, "-e", "console.error('exec: \"codex\": executable file not found in $PATH');process.exit(127)"]);
    expect(await h["settings.login"]!({ id: "codex" })).toEqual({ kind: "error", error: "Codex n'est pas encore installé dans l'atelier : ouvrez la vue agent ou redémarrez l'atelier (section Conteneur)." });
  });

  it("login needs a running workshop", async () => {
    const { h, o } = setup({ state: "arrete" });
    expect(await h["settings.login"]!({ id: "codex" })).toEqual({ kind: "error", error: "L'atelier de l'agent n'est pas démarré : voir Conteneur." });
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

  it("Mozilla account: issuer only, invalid input refused", async () => {
    const { h, o } = setup();
    expect(await h["settings.amoAccount"]!({})).toEqual({ saved: true, issuer: "user:1:2" });
    expect(await h["settings.setAmoAccount"]!({ issuer: "user:1:2", secret: "s" })).toEqual({ ok: true });
    expect(o.amoKeychain.write).toHaveBeenCalledWith("user:1:2", "s");
    expect(await h["settings.setAmoAccount"]!({ issuer: "bad", secret: "s" })).toEqual({ ok: false, error: "Clé invalide : x" });
    expect(await h["settings.setAmoAccount"]!({ issuer: 1, secret: null })).toMatchObject({ ok: false, error: expect.stringContaining("Clé invalide") });
    expect(await h["settings.deleteAmoAccount"]!({})).toEqual({ ok: true });
    vi.mocked(o.amoKeychain.issuer).mockResolvedValueOnce(null);
    expect(await h["settings.amoAccount"]!({})).toEqual({ saved: false, issuer: null });
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
    o.workshop.rebuild.mockImplementationOnce(() => new Promise((r) => (finish = () => r((calls.push("rebuild"), "demarre")))));
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

  it("pullModel: one pull at a time, progress visible meanwhile, refusal and errors returned", async () => {
    const { h, o } = setup();
    expect(await h["settings.pullModel"]!({ name: "llama3" })).toEqual({ ok: false, error: "Modèle non pris en charge" });
    const real = globalThis.fetch;
    let finish!: () => void;
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"status":"downloading","total":10,"completed":5}\n'));
        finish = () => (c.enqueue(new TextEncoder().encode('{"status":"success"}\n')), c.close());
      },
    });
    globalThis.fetch = (async () => new Response(body)) as any;
    try {
      const first = h["settings.pullModel"]!({ name: "gemma4:e4b-mlx" }) as Promise<unknown>;
      await vi.waitFor(async () => expect(await h["settings.pullProgress"]!({})).toEqual({ name: "gemma4:e4b-mlx", status: "downloading", percent: 50 }));
      expect(await h["settings.pullModel"]!({ name: "d1-2B" })).toMatchObject({ ok: false });
      finish();
      expect(await first).toEqual({ ok: true });
      expect(await h["settings.pullProgress"]!({})).toBeNull();
      expect(o.ai.ollamaUrl).toBe("http://127.0.0.1:11434");
      globalThis.fetch = (async () => new Response("no space", { status: 500 })) as any;
      expect(await h["settings.pullModel"]!({ name: "gemma4:e4b-mlx" })).toEqual({ ok: false, error: "no space" });
    } finally {
      globalThis.fetch = real;
    }
  });

  it("pullInBackground: answers at once, pulls in order, notifies the end or the failure", async () => {
    const { h, o } = setup();
    expect(await h["settings.pullInBackground"]!({ names: ["gemma4:e4b-mlx", "llama3"] })).toEqual({ ok: false, error: "Modèle non pris en charge" });
    expect(await h["settings.pullInBackground"]!({ names: [] })).toMatchObject({ ok: false });
    const real = globalThis.fetch;
    const pulled: string[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      pulled.push(JSON.parse(String(init.body)).model);
      return new Response('{"status":"success"}\n');
    }) as any;
    try {
      expect(await h["settings.pullInBackground"]!({ names: ["gemma4:e4b-mlx", "d1-2B"] })).toEqual({ ok: true });
      await vi.waitFor(() => expect(o.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "L'IA locale est prête" })));
      expect(pulled).toEqual(["gemma4:e4b-mlx"]);
      expect(o.ai.installDecisionModel).toHaveBeenCalledTimes(1);
      expect(await h["settings.pullProgress"]!({})).toBeNull();
      globalThis.fetch = (async () => new Response("no space", { status: 500 })) as any;
      expect(await h["settings.pullInBackground"]!({ names: ["gemma4:e4b-mlx"] })).toEqual({ ok: true });
      await vi.waitFor(() => expect(o.notify).toHaveBeenLastCalledWith({ title: "Le téléchargement de l'IA locale a échoué", text: "no space. Réessayez depuis Réglages › IA locale." }));
    } finally {
      globalThis.fetch = real;
    }
  });

  it("Ollama itself: its status rides on ai.state, start answers, and its download goes through the pull", async () => {
    const { h, calls } = setup({ ollama: { kind: "absent" } });
    expect(await h["ai.state"]!({})).toMatchObject({ ollama: { kind: "absent" } });
    expect(await h["settings.startOllama"]!({})).toEqual({ ok: true });
    expect(await h["settings.pullModel"]!({ name: "ollama" })).toEqual({ ok: true });
    expect(calls).toEqual(["ollama.start", "ollama.install"]);
    expect(await h["settings.pullProgress"]!({})).toBeNull();
  });

  it("Docker: its status and its start", async () => {
    const { h, calls } = setup();
    expect(await h["settings.docker"]!({})).toEqual({ kind: "stopped", app: "OrbStack" });
    expect(await h["settings.startDocker"]!({})).toEqual({ ok: true });
    expect(calls).toEqual(["docker.start"]);
  });

  it("ai.state", async () => {
    const { h } = setup();
    expect(await h["ai.state"]!({})).toMatchObject({ state: "stopped", verification: { decision: true }, ollamaUrl: "http://127.0.0.1:11434" });
  });

  it("the decision model downloads through LocalAi, in the single pull slot; pplx is no longer pullable", async () => {
    const { h, o, calls } = setup();
    expect(await h["settings.pullModel"]!({ name: "pplx-decider-flash" })).toEqual({ ok: false, error: "Modèle non pris en charge" });
    expect(await h["settings.pullModel"]!({ name: "d1-2B" })).toEqual({ ok: true });
    expect(calls).toEqual(["installDecisionModel"]);
    expect(o.ai.installDecisionModel).toHaveBeenCalledTimes(1);
    expect(await h["settings.pullProgress"]!({})).toBeNull();
  });

  it("a failed decision download stays in ai.state as decisionError until a later success", async () => {
    const { h, o } = setup();
    o.ai.installDecisionModel.mockImplementationOnce(async () => {
      throw new Error("HTTP 503");
    });
    h.downloadDecision();
    await vi.waitFor(async () => expect(await h["ai.state"]!({})).toMatchObject({ decisionError: "HTTP 503" }));
    expect(await h["settings.pullModel"]!({ name: "d1-2B" })).toEqual({ ok: true });
    expect(await h["ai.state"]!({})).not.toHaveProperty("decisionError");
  });

  it("cancels the decision download when AI goes off, without keeping an error", async () => {
    const { h, o } = setup();
    let fail!: (e: Error) => void;
    o.ai.installDecisionModel.mockImplementationOnce(() => new Promise<void>((_ok, ko) => (fail = ko)));
    o.ai.cancelInstall.mockImplementation(() => fail(new Error("Installation annulée")));
    h.downloadDecision();
    await vi.waitFor(async () => expect(await h["settings.pullProgress"]!({})).toMatchObject({ name: "d1-2B" }));
    h.cancelDecision();
    expect(o.ai.cancelInstall).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect(await h["settings.pullProgress"]!({})).toBeNull());
    expect(await h["ai.state"]!({})).not.toHaveProperty("decisionError");
  });

});
