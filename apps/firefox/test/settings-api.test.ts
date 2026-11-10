import { describe, expect, it, vi } from "vitest";
import type { Action } from "../shared/api";
import type { GrantRow } from "../shared/settings";
import { revealable } from "../chrome/store/settings";
import { createSettingsApi } from "../ui/settings-api";

function setup(answers: Record<string, (p: any) => unknown> = {}) {
  const openAgent = vi.fn();
  const switchAgent = vi.fn();
  const calls: { method: string; params: unknown }[] = [];
  const host = {
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      const a = answers[method];
      if (!a) throw new Error("down");
      return a(params);
    },
    notify: vi.fn(),
  } as any;
  const chrome = { telemetry: vi.fn(), setTelemetry: vi.fn(), version: vi.fn(), reveal: vi.fn(), exportFolder: async () => "/u/Downloads", reset: vi.fn() };
  const forget = vi.fn(async () => {});
  const sitePermissions = { list: async () => [{ profile: "default", origin: "https://a.fr", permissions: { "media-camera": "allow", notifications: "deny" } as const }], forget };
  const dispatched: Action[] = [];
  const api = createSettingsApi({
    host,
    chrome,
    sitePermissions: sitePermissions as any,
    dispatch: (a) => void dispatched.push(a),
    windowId: "W",
    openAgent,
    switchAgent,
    dataDir: "/u/WebAiOs",
  });
  return { api, calls, chrome, forget, dispatched, openAgent, switchAgent };
}

const row = (kind: GrantRow["kind"], key: string): GrantRow => ({ kind, key, name: key, profile: null, detail: "" });

describe("settings api", () => {
  it("grants order and labels", async () => {
    const { api } = setup({
      "settings.grants": () => [row("widget", "w1"), row("action", "a1")],
      "external.list": () => ({ clients: [{ id: "c1", name: "Claude" }] }),
    });
    const g = await api.grants();
    expect(g.map((r) => r.kind)).toEqual(["site", "widget", "action", "external"]);
    expect(g[0]!.profile).toBe("default");
    expect(g[0]!.detail).toBe("Caméra : autorisé · Notifications : refusé");
    expect(g[3]).toMatchObject({ name: "Claude", detail: "Projets externes du mode design" });
  });

  it("revoke routing", async () => {
    const { api, calls, forget } = setup({ "external.revoke": () => {}, "settings.revoke": () => {} });
    await api.revoke("site", "default\nhttps://a.fr");
    expect(forget).toHaveBeenCalledWith("default", "https://a.fr");
    await api.revoke("external", "c1");
    await api.revoke("widget", "w1");
    expect(calls.map((c) => c.method)).toEqual(["external.revoke", "settings.revoke"]);
  });

  it("host down", async () => {
    const { api } = setup();
    expect(await api.agents()).toEqual([]);
    expect(await api.workshop()).toBeNull();
    expect((await api.grants()).map((r) => r.kind)).toEqual(["site"]);
    expect(await api.restartWorkshop(true)).toEqual({ ok: false, error: "L'agent ne répond pas" });
    expect(api.dataDir()).toBe("/u/WebAiOs");
    expect(await api.backups()).toEqual([]);
    expect(await api.logout("claude")).toEqual([]);
  });

  it("the data folder does not wait for the backups", async () => {
    const { api } = setup({ "settings.backups": () => new Promise(() => {}) });
    expect(api.dataDir()).toBe("/u/WebAiOs");
  });

  it("login: a panel answer switches the agent and opens the panel; a device code is returned as is; a silent host is an error", async () => {
    const a = setup({ "settings.login": ({ id }) => (id === "claude" ? { kind: "panel" } : { kind: "device", url: "https://x", code: "AB-1" }) });
    expect(await a.api.login("claude")).toEqual({ kind: "panel" });
    expect(a.switchAgent).toHaveBeenCalledWith("claude");
    expect(a.openAgent).toHaveBeenCalledTimes(1);
    expect(await a.api.login("codex")).toEqual({ kind: "device", url: "https://x", code: "AB-1" });
    expect(a.openAgent).toHaveBeenCalledTimes(1);
    expect(await setup().api.login("codex")).toEqual({ kind: "error", error: "L'agent ne répond pas" });
  });

  it("the Codex key goes to the host", async () => {
    const { api, calls } = setup({ "settings.codexKey": () => ({ ok: true }) });
    expect(await api.setCodexKey("sk-1")).toEqual({ ok: true });
    expect(calls).toEqual([{ method: "settings.codexKey", params: { key: "sk-1" } }]);
  });

  it("logout shows the host's answer, in one request", async () => {
    const accounts = [{ id: "claude", name: "Claude Code", state: "logged-out" }];
    const { api, calls } = setup({ "settings.logout": () => accounts });
    expect(await api.logout("claude")).toEqual(accounts);
    expect(calls).toEqual([{ method: "settings.logout", params: { id: "claude" } }]);
  });

  it("reset: the chrome's answer, false when it fails", async () => {
    const { api, chrome } = setup();
    chrome.reset.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("disk"));
    expect(await api.reset()).toBe(false);
    expect(await api.reset()).toBe(false);
    chrome.reset.mockResolvedValueOnce(true);
    expect(await api.reset()).toBe(true);
  });

  it("export reveals", async () => {
    const path = "/u/Downloads/WebAiOs-donnees-2026-11-10.zip";
    const { api, calls, chrome } = setup({ "settings.export": () => ({ ok: true, path }) });
    expect(await api.exportData()).toEqual({ ok: true, path });
    expect(calls[0]!.params).toEqual({ to: "/u/Downloads" });
    expect(chrome.reveal).toHaveBeenCalledWith(path);
  });

  it("revealable", () => {
    const r = (p: string) => revealable("/u/WebAiOs", "/u/Downloads", p);
    for (const p of ["/u/WebAiOs", "/u/WebAiOs.backup-2026-11-10T13-35-12-345Z", "/u/Downloads/WebAiOs-donnees-2026-11-10 (2).zip"]) expect(r(p)).toBe(true);
    for (const p of ["/u/WebAiOs/workspace", "/u/WebAiOs.backup-x", "/u/Downloads/autre.zip", "/u/Downloads/../WebAiOs-donnees-2026-11-10.zip", "/etc"]) expect(r(p)).toBe(false);
  });

  it("openAdvanced", () => {
    const { api, dispatched } = setup();
    api.openAdvanced();
    expect(dispatched).toEqual([{ type: "openTab", windowId: "W", url: "about:preferences", activate: true }]);
  });
});
