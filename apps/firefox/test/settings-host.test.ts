import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsHandlers } from "../host/settings";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(over: { state?: string; exec?: (argv: string[]) => unknown } = {}) {
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
    },
    ai: {
      state: () => ({ state: "stopped" as const }),
      check: async () => ({ kev: true, uv: true, ollama: true, gemma: false, decision: true }),
      ollamaUrl: "http://127.0.0.1:11434",
      setDecisionModel: vi.fn(),
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
  };
  return { o, exec, calls, h: createSettingsHandlers(o) };
}

describe("settings host", () => {
  it("docker absent", async () => {
    const { h, exec } = setup({ state: "docker-absent" });
    expect(await h["settings.agents"]!({})).toEqual([{ id: "claude", name: "Claude Code", state: "docker-absent" }]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("container stopped", async () => {
    const { h } = setup({ state: "arrete" });
    expect(await h["settings.agents"]!({})).toEqual([{ id: "claude", name: "Claude Code", state: "no-container" }]);
  });

  it("logged in, out and error", async () => {
    const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "boom" });
    let r = out('{"loggedIn":true,"email":"ami@example.com"}');
    const { h } = setup({ exec: async () => r });
    expect(await h["settings.agents"]!({})).toMatchObject([{ state: "logged-in", account: "ami@example.com" }]);
    r = out('{"loggedIn":false}');
    expect(await h["settings.agents"]!({})).toMatchObject([{ state: "logged-out" }]);
    r = out("", 1);
    expect(await h["settings.agents"]!({})).toMatchObject([{ state: "error", error: "boom" }]);
    r = out("not json");
    expect(await h["settings.agents"]!({})).toMatchObject([{ state: "error" }]);
  });

  it("logout touches nothing else", async () => {
    const { h, exec, o } = setup();
    await h["settings.logout"]!({ id: "claude" });
    expect(exec).toHaveBeenNthCalledWith(1, ["claude", "auth", "logout"]);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(o.relaunchSessions).not.toHaveBeenCalled();
    expect(o.stopApps).not.toHaveBeenCalled();
    exec.mockClear();
    await h["settings.logout"]!({ id: "nope" });
    expect(exec).toHaveBeenCalledTimes(1); // only the status re-read
    expect(exec).not.toHaveBeenCalledWith(["claude", "auth", "logout"]);
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

  it("ai.state and decision model", async () => {
    const { h, o } = setup();
    expect(await h["ai.state"]!({})).toMatchObject({ state: "stopped", verification: { decision: true }, ollamaUrl: "http://127.0.0.1:11434" });
    h["ai.decisionModel"]!({ model: "kev" });
    expect(o.ai.setDecisionModel).toHaveBeenLastCalledWith(undefined);
    h["ai.decisionModel"]!({ model: "pplx-decider-flash" });
    expect(o.ai.setDecisionModel).toHaveBeenLastCalledWith("pplx-decider-flash");
  });
});
