import type { Action, SettingsApi } from "../shared/api";
import { format } from "../shared/i18n";
import type { WindowId } from "../shared/model";
import type { AgentAccount, Backup, GrantKind, LoginResult, GrantRow, SettingsResult, WorkshopOperation, PullProgress, DockerStatus, MachineShown } from "../shared/settings";
import type { AgentHost } from "../chrome/agent/host";
import type { SettingsChrome } from "../chrome/store/settings";
import type { SitePermissions } from "../chrome/store/site-permissions";
import type { PassportSettings } from "../chrome/passport/settings";
import type { PassportImporter } from "../chrome/passport/import";
import type { PasswordSettings } from "../chrome/passwords/settings";
import { passportName, type Space } from "../shared/model";

/** The site permissions Settings lists, with their message ids. */
const LABELS = new Set(["notifications", "geolocation", "media-camera", "media-micro", "midi", "drm"]);
const DECISIONS = new Set(["allow", "deny"]);

/** The main UI document (sidebar.html, no query), the one that shows ressac://settings; not the agent panel's nor a pill's. */
export const settingsPageDocument = (url: { pathname: string; search: string }) => url.pathname.endsWith("/sidebar.html") && url.search === "";

/** The settings page's API: the host's RPCs, the chrome's own actions and the site decisions, with the host's silence handled. */
export function createSettingsApi(o: {
  host: Pick<AgentHost, "request" | "notify">;
  chrome: SettingsChrome;
  sitePermissions: Pick<SitePermissions, "list" | "forget">;
  dispatch(a: Action): void;
  windowId: WindowId;
  openAgent(): void;
  switchAgent(profile: string): void;
  dataDir: string;
  /** The shown language, read at each call. */
  locale(): string;
  /** Only in the document showing the settings page: elsewhere the API has no `passport`. */
  passport?: Pick<PassportSettings, "passports" | "unlock" | "read" | "save" | "lock" | "onLocked" | "removePassport" | "moveTo" | "restart">;
  /** Only in the document showing the settings page (the welcome's too), like `passport`: keys and « Moi / Un proche » in, never a value. */
  passportImport?: Pick<PassportImporter, "sources" | "proposals" | "add">;
  /** Only in the document showing the settings page, like `passport`. */
  passwords?: PasswordSettings;
  /** The spaces, read at each call: they name the passports. */
  spaces(): readonly Pick<Space, "name" | "profile" | "private">[];
  /** Ends a chrome subscription with this document (api.ts): the chrome outlives a closed settings page. */
  untilUnload(unsubscribe: () => void): () => void;
}): SettingsApi {
  const say = (id: string, args?: Record<string, string>) => format(o.locale(), id, args);
  const silent = (): { ok: false; error: string } => ({ ok: false, error: say("sidebar-api-agent-silent") });
  /** A host answer copied into this realm; `fallback` when the host does not answer. */
  const ask = <T>(method: string, params: unknown, fallback: T): Promise<T> => o.host.request<T>(method, params).then((r) => structuredClone(r), () => fallback);
  const agents = () => ask<AgentAccount[]>("settings.agents", undefined, []);
  const siteRows = async (): Promise<GrantRow[]> => {
    const list = await o.sitePermissions.list();
    return list.map(({ profile, origin, permissions }) => {
      let name = origin;
      try {
        name = new URL(origin).host;
      } catch {}
      const detail = Object.entries(permissions)
        .filter(([k]) => LABELS.has(k))
        .map(([k, d]) => say("agent-grants-site-permission", { label: say(`agent-permission-${k}`), decision: DECISIONS.has(d) ? say(`agent-grants-${d === "allow" ? "allowed" : "denied"}`) : d }))
        .sort()
        .join(" · ");
      return { kind: "site", key: `${profile}\n${origin}`, name, profile, detail };
    });
  };
  const nameOf = (profile: string) => passportName(o.spaces(), profile, say("settings-passport-no-space"));
  /** The tokens this page holds, one per profile and purpose: its « Verrouiller » never locks another window's page. */
  const tokens = new Map<string, string>();
  const key = (profile: string, purpose: string) => `${purpose}\n${profile}`;
  // As for passwords: the page passes only tokens it was given, never one it found elsewhere.
  const ours = (token: unknown) => (typeof token === "string" && [...tokens.values()].includes(token) ? token : "");
  const passport = o.passport;
  const passwords = o.passwords;
  /** This page's password tokens: only they reach the chrome, and leaving the section revokes them. */
  const pageTokens = new Set<string>();
  const mine = (token: unknown) => (typeof token === "string" && pageTokens.has(token) ? token : "");
  const importer = o.passportImport;
  return {
    ...(importer && {
      passportImport: {
        sources: () => importer.sources().then((r) => structuredClone(r)),
        proposals: (source) => importer.proposals(String(source)).then((r) => structuredClone(r)),
        add: (profile, rows, source, eraseRessac) =>
          importer.add(String(profile), (Array.isArray(rows) ? rows : []).map((r) => ({ key: String(r?.key), as: r?.as === "proche" ? "proche" : "me" })), String(source), eraseRessac === true).then((r) => structuredClone(r)),
      },
    }),
    ...(passwords && {
      passwords: {
        list: () => passwords.list().then((r) => structuredClone(r)),
        async unlock() {
          const r = await passwords.unlock(say("settings-passwords-touchid"));
          if (!r) return null;
          pageTokens.add(r.token);
          return structuredClone(r);
        },
        lock() {
          for (const token of pageTokens) passwords.lock(token);
          pageTokens.clear();
        },
        onLocked: (callback) => o.untilUnload(passwords.onLocked(callback)),
        reveal: (token, guid) => passwords.reveal(mine(token), String(guid)),
        copyPassword: (token, guid) => passwords.copyPassword(mine(token), String(guid)),
        copyUsername: (guid) => passwords.copyUsername(String(guid)),
        add: (token, l) => passwords.add(mine(token), { origin: String(l?.origin ?? ""), username: String(l?.username ?? ""), password: String(l?.password ?? "") }).then((r) => structuredClone(r)),
        edit: (token, guid, c) => passwords.edit(mine(token), String(guid), { username: String(c?.username ?? ""), password: String(c?.password ?? "") }).then((r) => structuredClone(r)),
        remove: (token, guid) => passwords.remove(mine(token), String(guid)).then((r) => structuredClone(r)),
        primaryPassword: () => passwords.primaryPassword(),
      },
    }),
    ...(passport && {
      passport: {
        async profiles() {
          const [files, spaces] = [await passport.passports(), o.spaces()];
          const named = [...new Set(spaces.filter((s) => !s.private).map((s) => s.profile))];
          // A profile used only by private spaces has no passport of its own (design § 3.2, ruling F25).
          const hidden = new Set(spaces.map((s) => s.profile));
          const of = (id: string) => files.find((f) => f.profile === id);
          return [
            ...named.map((id) => ({ id, name: nameOf(id), count: of(id)?.count ?? 0, state: of(id)?.state ?? ("ok" as const), kept: false })),
            ...files.filter((f) => !hidden.has(f.profile)).map((f) => ({ id: f.profile, name: nameOf(f.profile), count: f.count, state: f.state, kept: true })),
          ];
        },
        async unlock(profile, purpose = "open") {
          const reason =
            purpose === "delete" || purpose === "move" || purpose === "restart" ? say(`settings-passport-touchid-${purpose}`) : say("settings-passport-touchid", { profile: nameOf(String(profile)) });
          const r = await passport.unlock(String(profile), reason, purpose);
          if (!r) return null;
          const before = tokens.get(key(profile, purpose));
          if (before) passport.lock(before);
          tokens.set(key(profile, purpose), r.token);
          return structuredClone(r);
        },
        read: (profile, token) => passport.read(String(profile), ours(token)).then((r) => structuredClone(r)),
        save: (profile, token, entries, revision) => passport.save(String(profile), ours(token), structuredClone(entries), String(revision)).then((r) => structuredClone(r)),
        lock(profile, purpose) {
          for (const p of purpose ? [purpose] : (["open", "delete", "move", "restart"] as const)) {
            const token = tokens.get(key(profile, p));
            if (token) passport.lock(token);
            tokens.delete(key(profile, p));
          }
        },
        onLocked: (callback) => o.untilUnload(passport.onLocked(callback)),
        removePassport: (profile, token) => passport.removePassport(String(profile), ours(token)),
        moveTo: (from, to, token) => passport.moveTo(String(from), String(to), ours(token)).then((r) => structuredClone(r)),
        restart: (profile, token) => passport.restart(String(profile), ours(token)),
      },
    }),
    agents,
    async login(id) {
      const r = await ask<LoginResult>("settings.login", { id }, { kind: "error", error: silent().error });
      if (r.kind === "panel") {
        o.switchAgent(id);
        o.openAgent();
      }
      return r;
    },
    logout: (id) => ask<AgentAccount[]>("settings.logout", { id }, []),
    workshop: () => ask("settings.workshop", undefined, null),
    restartWorkshop: (fresh) => ask<SettingsResult>("settings.restartWorkshop", { fresh }, silent()),
    workshopOperation: () => ask<WorkshopOperation>("settings.workshopOperation", undefined, null),
    codexKeySaved: () => ask<boolean>("settings.codexKeySaved", undefined, false),
    setCodexKey: (key) => ask<SettingsResult>("settings.codexKey", { key }, silent()),
    deleteCodexKey: () => ask<SettingsResult>("settings.codexKeyDelete", undefined, silent()),
    chooseCodexEngine: (engine) => o.dispatch({ type: "chooseCodexEngine", engine }),
    claudeKeySaved: () => ask<boolean>("settings.claudeKeySaved", undefined, false),
    setClaudeKey: (key) => ask<SettingsResult>("settings.claudeKey", { key }, silent()),
    deleteClaudeKey: () => ask<SettingsResult>("settings.claudeKeyDelete", undefined, silent()),
    chooseClaudeEngine: (engine) => o.dispatch({ type: "chooseClaudeEngine", engine }),
    pullModel: (name) => ask<SettingsResult>("settings.pullModel", { name }, silent()),
    pullProgress: () => ask<PullProgress | null>("settings.pullProgress", undefined, null),
    docker: () => ask<DockerStatus | null>("settings.docker", undefined, null),
    startDocker: () => ask<SettingsResult>("settings.startDocker", undefined, silent()),
    machine: () => ask<MachineShown | null>("settings.machine", undefined, null),
    machineUsage: () => ask<{ memoryMB: number; diskMB: number } | null>("settings.machineUsage", undefined, null),
    machineInstall: () => ask<SettingsResult>("settings.machineInstall", undefined, silent()),
    machineRemove: (force) => ask<SettingsResult>("settings.machineRemove", { force }, silent()),
    machineSwitchNow: () => ask<SettingsResult>("settings.machineSwitchNow", undefined, silent()),
    writer: () => ask<{ agent: "claude" | "codex" | "workshop-stopped" | null }>("ai.writer", undefined, { agent: null }),
    pullInBackground: (names) => ask<SettingsResult>("settings.pullInBackground", { names }, silent()),
    ollamaModels: (url) => ask("settings.ollamaModels", { url }, { ok: false as const, error: say("agent-ollama-silent") }),
    async grants() {
      const [sites, host, external] = await Promise.all([
        siteRows(),
        ask<GrantRow[]>("settings.grants", undefined, []),
        ask<{ clients: { id: string; name: string }[] } | null>("external.list", undefined, null),
      ]);
      const clients: GrantRow[] = (external?.clients ?? []).map((c) => ({ kind: "external", key: c.id, name: c.name, profile: null, detail: say("agent-grants-external") }));
      return [...sites, ...host, ...clients];
    },
    async revoke(kind: GrantKind, key) {
      if (kind === "site") {
        const i = key.indexOf("\n");
        if (i > 0) await o.sitePermissions.forget(key.slice(0, i), key.slice(i + 1));
      } else if (kind === "external") await ask("external.revoke", { id: key }, undefined);
      else await ask("settings.revoke", { kind, key }, undefined);
    },
    dataDir: () => o.dataDir,
    backups: () => ask<Backup[]>("settings.backups", undefined, []),
    reveal: (path) => o.chrome.reveal(path),
    deleteBackup: (path) => ask<SettingsResult>("settings.deleteBackup", { path }, silent()),
    async exportData() {
      const to = await o.chrome.exportFolder();
      const r = await ask<{ ok: true; path: string } | { ok: false; error: string }>("settings.export", { to }, silent());
      if (r.ok) o.chrome.reveal(r.path);
      return r;
    },
    reset: () =>
      o.chrome.reset().catch((e) => {
        console.error("[settings] reset:", e);
        return false;
      }),
    telemetry: async () => o.chrome.telemetry(),
    setTelemetry: (enabled) => o.chrome.setTelemetry(enabled),
    setCrashReports: (on) => o.chrome.setCrashReports(on),
    version: async () => o.chrome.version(),
    defaultBrowser: async () => o.chrome.defaultBrowser(),
    setDefaultBrowser: () => o.chrome.setDefaultBrowser(),
    repairScreenSharing: () => o.chrome.repairScreenSharing().catch(() => false),
    // #privacy: Firefox 161's page opens on its account pane, which Ressac hides (chrome/store/preferences-cleanup.ts).
    openAdvanced: () => o.dispatch({ type: "openTab", windowId: o.windowId, url: "about:preferences#privacy", activate: true }),
    openNotificationSettings: () => o.chrome.openNotificationSettings(),
    openFullDiskAccessSettings: () => o.chrome.openFullDiskAccessSettings(),
    openFilesAndFoldersSettings: () => o.chrome.openFilesAndFoldersSettings(),
    checkForUpdate: () => o.chrome.checkForUpdate(),
    restartToUpdate: () => o.chrome.restartToUpdate(),
    downloadUpdate: () => o.dispatch({ type: "openTab", windowId: o.windowId, url: o.chrome.updateDownloadUrl(), activate: true }),
    openUrl(url) {
      if (typeof url === "string" && url.startsWith("https://")) o.dispatch({ type: "openTab", windowId: o.windowId, url, activate: true });
    },
  };
}
