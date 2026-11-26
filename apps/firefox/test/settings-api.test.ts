import { describe, expect, it, vi } from "vitest";
import type { Action } from "../shared/api";
import type { GrantRow } from "../shared/settings";
import { bundleId, createSettingsChrome, revealable } from "../chrome/store/settings";
import { createSettingsApi, settingsPageDocument } from "../ui/settings-api";
import { createReviewApi } from "../ui/design-api";
import { createBadgeApi } from "../ui/badge-api";

function setup(answers: Record<string, (p: any) => unknown> = {}, settingsPage = true) {
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
  const chrome = { telemetry: vi.fn(), setTelemetry: vi.fn(), setCrashReports: vi.fn(), version: vi.fn(), defaultBrowser: vi.fn(() => true), setDefaultBrowser: vi.fn(), repairScreenSharing: vi.fn(async () => true), passportSuggest: vi.fn(() => ({ on: true, muted: ["a.fr"] })), setPassportSuggest: vi.fn(), unmutePassportSite: vi.fn(), reveal: vi.fn(), openNotificationSettings: vi.fn(), openFullDiskAccessSettings: vi.fn(), openFilesAndFoldersSettings: vi.fn(), exportFolder: async () => "/u/Downloads", reset: vi.fn(), checkForUpdate: vi.fn(), restartToUpdate: vi.fn(), updateDownloadUrl: vi.fn(() => "https://updates.example/updates/k/Ressac.dmg") };
  const forget = vi.fn(async () => {});
  const sitePermissions = { list: async () => [{ profile: "default", origin: "https://a.fr", permissions: { "media-camera": "allow", notifications: "deny" } as const }], forget };
  const dispatched: Action[] = [];
  const untilUnload: (() => void)[] = [];
  const passport = {
    passports: vi.fn(async () => [
      { profile: "default", count: 2, state: "ok" as const },
      { profile: "gone", count: 3, state: "newer" as const },
      { profile: "secret", count: 1, state: "ok" as const },
    ]),
    unlock: vi.fn(async () => ({ token: "t1", until: 9, showMs: 20_000 })),
    read: vi.fn(async () => null),
    save: vi.fn(async () => ({ ok: true as const, revision: "r", uncovered: 0 })),
    lock: vi.fn(),
    onLocked: vi.fn(() => () => {}),
    drop: vi.fn(async () => true),
    removePassport: vi.fn(async () => true),
    moveTo: vi.fn(async () => ({ ok: true as const })),
    restart: vi.fn(async () => true),
  };
  const passwords = {
    list: vi.fn(async () => [{ guid: "g1", origin: "https://a.test", host: "a.test", username: "camille" }]),
    unlock: vi.fn(async (_reason: string) => ({ token: "pw1", until: 9, showMs: 20_000 })),
    lock: vi.fn(),
    lockAll: vi.fn(),
    onLocked: vi.fn(() => () => {}),
    reveal: vi.fn(async (_token: string, _guid: string) => "mot-de-passe-test-1"),
    copyPassword: vi.fn(async (_token: string, _guid: string) => true),
    copyUsername: vi.fn(async (_guid: string) => true),
    add: vi.fn(async () => ({ ok: true as const, guid: "g2" })),
    edit: vi.fn(async () => ({ ok: true as const, guid: "g1" })),
    remove: vi.fn(async () => ({ ok: true as const, guid: "g1" })),
    primaryPassword: vi.fn(() => false),
  };
  const spaces = [
    { id: "s1", name: "Perso", profile: "default", private: false },
    { id: "s2", name: "Privé", profile: "secret", private: true },
    { id: "s3", name: "Travail", profile: "work", private: false },
    { id: "s4", name: "Clients", profile: "work", private: false },
  ];
  const api = createSettingsApi({
    ...(settingsPage ? { passport, passwords, passportImport: { sources: async () => [], proposals: async () => ({ proposals: [], incomplete: 0, name: "", access: "ready" as const }), add: async () => ({ ok: true as const, added: 0, variants: 0, full: 0, invalid: 0 }) } } : {}),
    spaces: () => spaces as any,
    host,
    chrome,
    sitePermissions: sitePermissions as any,
    dispatch: (a) => void dispatched.push(a),
    windowId: "W",
    openAgent,
    switchAgent,
    dataDir: "/u/Ressac",
    locale: () => "fr",
    untilUnload: (off) => (untilUnload.push(off), off),
  });
  return { api, calls, chrome, forget, dispatched, openAgent, switchAgent, passport, passwords, untilUnload };
}

const row = (kind: GrantRow["kind"], key: string): GrantRow => ({ kind, key, name: key, profile: null, detail: "" });

describe("settings api", () => {
  it("onLocked subscriptions end with the page's document", () => {
    const { api, untilUnload } = setup();
    const offPw = api.passwords!.onLocked(() => {});
    const offPp = api.passport!.onLocked(() => {});
    expect(untilUnload).toEqual([offPw, offPp]);
  });

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
    expect(api.dataDir()).toBe("/u/Ressac");
    expect(await api.backups()).toEqual([]);
    expect(await api.logout("claude")).toEqual([]);
  });

  it("the data folder does not wait for the backups", async () => {
    const { api } = setup({ "settings.backups": () => new Promise(() => {}) });
    expect(api.dataDir()).toBe("/u/Ressac");
  });

  it("login: a panel answer switches the agent and opens the panel; a device code is returned as is; a silent host is an error", async () => {
    const a = setup({ "settings.login": ({ id }) => (id === "claude" ? { kind: "terminal" } : { kind: "device", url: "https://x", code: "AB-1" }) });
    expect(await a.api.login("claude")).toEqual({ kind: "terminal" });
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

  it("the Claude key and engine go to the host", async () => {
    const { api, calls, dispatched } = setup({ "settings.claudeKey": () => ({ ok: true }), "settings.claudeKeySaved": () => true, "settings.claudeKeyDelete": () => ({ ok: true }) });
    expect(await api.setClaudeKey("sk-1")).toEqual({ ok: true });
    expect(await api.claudeKeySaved()).toBe(true);
    expect(await api.deleteClaudeKey()).toEqual({ ok: true });
    expect(calls).toEqual([
      { method: "settings.claudeKey", params: { key: "sk-1" } },
      { method: "settings.claudeKeySaved", params: undefined },
      { method: "settings.claudeKeyDelete", params: undefined },
    ]);
    const engine = { kind: "ollama" as const, ollamaUrl: "http://h:1", ollamaModel: "m", apiUrl: "", apiModel: "" };
    api.chooseClaudeEngine(engine);
    expect(dispatched).toEqual([{ type: "chooseClaudeEngine", engine }]);
  });

  it("the own engine is saved only once the host accepts it", async () => {
    const ok = { kind: "ollama" as const, ollamaUrl: "http://127.0.0.1:11434", ollamaModel: "m", apiUrl: "", apiModel: "" };
    const far = { ...ok, ollamaUrl: "http://192.168.1.4:11434" };
    const { api, dispatched } = setup({ "agent.ownEngine": (p: { engine: typeof ok }) => (p.engine.ollamaUrl === ok.ollamaUrl ? { ok: true } : { ok: false, error: "refusée" }) });
    expect(await api.chooseOwnEngine(far)).toEqual({ ok: false, error: "refusée" });
    expect(await api.chooseOwnEngine(ok)).toEqual({ ok: true });
    expect(dispatched).toEqual([{ type: "chooseOwnEngine", engine: ok }]);
    // A silent host saves nothing either.
    const silent = setup();
    expect(await silent.api.chooseOwnEngine(ok)).toMatchObject({ ok: false });
    expect(silent.dispatched).toEqual([]);
  });

  it("ollamaModels: the host's list, the unreachable answer when the host is silent", async () => {
    const list = { ok: true, models: [{ name: "a" }] };
    expect(await setup({ "settings.ollamaModels": () => list }).api.ollamaModels("http://h:1")).toEqual(list);
    expect(await setup().api.ollamaModels("http://h:1")).toEqual({ ok: false, error: "Ollama ne répond pas à cette adresse." });
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
    const path = "/u/Downloads/Ressac-donnees-2026-11-10.zip";
    const { api, calls, chrome } = setup({ "settings.export": () => ({ ok: true, path }) });
    expect(await api.exportData()).toEqual({ ok: true, path });
    expect(calls[0]!.params).toEqual({ to: "/u/Downloads" });
    expect(chrome.reveal).toHaveBeenCalledWith(path);
  });

  it("revealable", () => {
    const r = (p: string) => revealable("/u/Ressac", "/u/Downloads", p);
    for (const p of ["/u/Ressac", "/u/Ressac.backup-2026-11-10T13-35-12-345Z", "/u/Downloads/Ressac-donnees-2026-11-10 (2).zip", "/u/Ressac/workspace/.ressac/browsing-notes.md", "/u/Ressac/masking/quarantine/2026-11-23T10-00-00Z/workspace/a.txt"]) expect(r(p)).toBe(true);
    for (const p of ["/u/Ressac/masking/quarantine/../lock.json", "/u/Ressac/masking/quarantine/", "/u/Ressac/masking/quarantine//x", "/u/Ressac/workspace", "/u/Ressac.backup-x", "/u/Downloads/autre.zip", "/u/Downloads/../Ressac-donnees-2026-11-10.zip", "/etc"]) expect(r(p)).toBe(false);
  });

  it("default browser: read and asked through the chrome", async () => {
    const { api, chrome } = setup();
    expect(await api.defaultBrowser()).toBe(true);
    api.setDefaultBrowser();
    expect(chrome.setDefaultBrowser).toHaveBeenCalledOnce();
  });

  it("bundleId reads the identifier macOS knows the app by", () => {
    expect(bundleId("<dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>fr.ressac.fr.ressac.browser</string>\n</dict>")).toBe("fr.ressac.fr.ressac.browser");
    expect(bundleId("<dict><key>CFBundleName</key><string>Ressac</string></dict>")).toBeNull();
    expect(bundleId("<key>CFBundleIdentifier</key><string>a; rm -rf /</string>")).toBeNull();
  });

  it("openAdvanced", () => {
    const { api, dispatched } = setup();
    api.openAdvanced();
    expect(dispatched).toEqual([{ type: "openTab", windowId: "W", url: "about:preferences#privacy", activate: true }]);
  });

  it("passport profiles: the spaces' profiles in sidebar order, then kept passports « Sans espace »; none used only by private spaces", async () => {
    const { api } = setup();
    expect(await api.passport!.profiles()).toEqual([
      { id: "default", name: "Perso", count: 2, state: "ok", kept: false },
      { id: "work", name: "Travail, Clients", count: 0, state: "ok", kept: false },
      { id: "gone", name: "Sans espace", count: 3, state: "newer", kept: true },
    ]);
  });

  it("passport unlock asks Touch ID with the profile's name; lock revokes only this page's token", async () => {
    const { api, passport } = setup();
    expect(await api.passport!.unlock("work")).toEqual({ token: "t1", until: 9, showMs: 20_000 });
    expect(passport.unlock).toHaveBeenCalledWith("work", "ouvrir votre passeport « Travail, Clients »", "open");
    api.passport!.lock("default");
    expect(passport.lock).not.toHaveBeenCalled();
    api.passport!.lock("work");
    expect(passport.lock).toHaveBeenCalledWith("t1");
  });

  it("passport: no drop without Touch ID for a page, and a token this page was not given goes nowhere", async () => {
    const { api, passport } = setup();
    expect(api.passport).not.toHaveProperty("drop");
    await api.passport!.removePassport("work", "found-elsewhere");
    expect(passport.removePassport).toHaveBeenCalledWith("work", "");
    await api.passport!.read("work", "found-elsewhere");
    expect(passport.read).toHaveBeenCalledWith("work", "");
  });

  it("passport delete and move: Touch ID with their own reason, then the chrome's answer, token forwarded", async () => {
    const { api, passport } = setup();
    await api.passport!.unlock("gone", "delete");
    expect(passport.unlock).toHaveBeenLastCalledWith("gone", "supprimer votre passeport", "delete");
    await api.passport!.unlock("gone", "move");
    expect(passport.unlock).toHaveBeenLastCalledWith("gone", "déplacer votre passeport", "move");
    await api.passport!.unlock("gone", "restart");
    expect(passport.unlock).toHaveBeenLastCalledWith("gone", "recréer votre passeport", "restart");
    // One token per purpose: asking a delete never revokes the open view's; lock(profile, purpose) only that one.
    passport.unlock.mockResolvedValueOnce({ token: "open1", until: 9, showMs: 1 });
    await api.passport!.unlock("gone");
    passport.unlock.mockResolvedValueOnce({ token: "del1", until: 9, showMs: 1 });
    await api.passport!.unlock("gone", "delete");
    expect(passport.lock).not.toHaveBeenCalledWith("open1");
    api.passport!.lock("gone", "delete");
    expect(passport.lock).toHaveBeenLastCalledWith("del1");
    expect(passport.lock).not.toHaveBeenCalledWith("open1");
    expect(await api.passport!.removePassport("gone", "t1")).toBe(true);
    expect(passport.removePassport).toHaveBeenCalledWith("gone", "t1");
    expect(await api.passport!.moveTo("gone", "default", "t1")).toEqual({ ok: true });
    expect(passport.moveTo).toHaveBeenCalledWith("gone", "default", "t1");
    expect(await api.passport!.restart("gone", "t1")).toBe(true);
    expect(passport.restart).toHaveBeenCalledWith("gone", "t1");
  });

  it("passwords: Touch ID with its reason; only this page's tokens reach the chrome; lock revokes them", async () => {
    const { api, passwords } = setup();
    expect(await api.passwords!.unlock()).toEqual({ token: "pw1", until: 9, showMs: 20_000 });
    expect(passwords.unlock).toHaveBeenCalledWith("gérer vos mots de passe");
    expect(await api.passwords!.reveal("pw1", "g1")).toBe("mot-de-passe-test-1");
    expect(passwords.reveal).toHaveBeenLastCalledWith("pw1", "g1");
    // A token this page never got (another window's) goes to the chrome empty: refused there.
    await api.passwords!.reveal("other-page", "g1");
    expect(passwords.reveal).toHaveBeenLastCalledWith("", "g1");
    await api.passwords!.add("other-page", { origin: "https://b.test", username: "u", password: "p" });
    expect(passwords.add).toHaveBeenLastCalledWith("", { origin: "https://b.test", username: "u", password: "p" });
    api.passwords!.lock();
    expect(passwords.lock).toHaveBeenCalledWith("pw1");
    await api.passwords!.copyPassword("pw1", "g1");
    expect(passwords.copyPassword).toHaveBeenLastCalledWith("", "g1");
  });

  it("the passport API exists only on the settings page's API", () => {
    expect(setup().api).toHaveProperty("passport");
    // The agent panel's document builds the same API without it (ui/install-api.ts).
    expect(setup({}, false).api).not.toHaveProperty("passport");
    expect(setup().api).toHaveProperty("passwords");
    expect(setup({}, false).api).not.toHaveProperty("passwords");
    expect(setup({}, false).api).not.toHaveProperty("passportImport");
    expect(setup().api).toHaveProperty("passportImport");
    expect(settingsPageDocument({ pathname: "/content/ressac/sidebar.html", search: "" })).toBe(true);
    for (const url of [{ pathname: "/content/ressac/agent.html", search: "" }, { pathname: "/content/ressac/sidebar.html", search: "?agentview" }, { pathname: "/content/ressac/sidebar.html", search: "?badge=x" }])
      expect(settingsPageDocument(url)).toBe(false);
    const review = createReviewApi({ host: { request: async () => null } as any });
    const badge = createBadgeApi({} as any);
    for (const other of [review, badge]) expect(other).not.toHaveProperty("passport"), expect(other).not.toHaveProperty("passwords");
  });
});

describe("passport suggestions", () => {
  it("the suggest toggle and muted sites read and write their prefs", async () => {
    const prefs = new Map<string, boolean | string>();
    vi.stubGlobal("Services", {
      env: { get: () => "" },
      prefs: {
        getBoolPref: (k: string, d: boolean) => (prefs.get(k) as boolean) ?? d,
        setBoolPref: (k: string, v: boolean) => void prefs.set(k, v),
        getCharPref: (k: string, d: string) => (prefs.get(k) as string) ?? d,
        setCharPref: (k: string, v: string) => void prefs.set(k, v),
      },
    });
    try {
      const chrome = createSettingsChrome("/d", false, { check() {}, restart() {} });
      expect(chrome.passportSuggest()).toEqual({ on: true, muted: [] });
      prefs.set("ressac.passport.suggestMuted", "a.fr,b.fr");
      chrome.setPassportSuggest(false);
      expect(prefs.get("ressac.passport.suggest")).toBe(false);
      expect(chrome.passportSuggest()).toEqual({ on: false, muted: ["a.fr", "b.fr"] });
      chrome.unmutePassportSite("a.fr");
      expect(prefs.get("ressac.passport.suggestMuted")).toBe("b.fr");
      chrome.setPassportSuggest("no" as any);
      expect(prefs.get("ressac.passport.suggest")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the API passes them through from the page", async () => {
    const { api, chrome } = setup();
    expect(await api.passportSuggest()).toEqual({ on: true, muted: ["a.fr"] });
    api.setPassportSuggest(false);
    api.unmutePassportSite("a.fr");
    expect(chrome.setPassportSuggest).toHaveBeenCalledWith(false);
    expect(chrome.unmutePassportSite).toHaveBeenCalledWith("a.fr");
  });
});
