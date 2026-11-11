import type { Action, SettingsApi } from "../shared/api";
import type { WindowId } from "../shared/model";
import type { AgentAccount, Backup, GrantKind, LoginResult, GrantRow, SettingsResult, WorkshopOperation, PullProgress } from "../shared/settings";
import type { AgentHost } from "../chrome/agent/host";
import type { SettingsChrome } from "../chrome/store/settings";
import type { SitePermissions } from "../chrome/store/site-permissions";

const SILENT: { ok: false; error: string } = { ok: false, error: "L'agent ne répond pas" };
const LABELS: Record<string, string> = { notifications: "Notifications", geolocation: "Position", "media-camera": "Caméra", "media-micro": "Micro", midi: "MIDI", drm: "Contenu protégé" };
const DECISIONS = { allow: "autorisé", deny: "refusé" } as const;

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
}): SettingsApi {
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
        .filter(([k]) => k in LABELS)
        .map(([k, d]) => `${LABELS[k]} : ${DECISIONS[d as keyof typeof DECISIONS] ?? d}`)
        .sort()
        .join(" · ");
      return { kind: "site", key: `${profile}\n${origin}`, name, profile, detail };
    });
  };
  return {
    agents,
    async login(id) {
      const r = await ask<LoginResult>("settings.login", { id }, { kind: "error", error: SILENT.error });
      if (r.kind === "panel") {
        o.switchAgent(id);
        o.openAgent();
      }
      return r;
    },
    logout: (id) => ask<AgentAccount[]>("settings.logout", { id }, []),
    workshop: () => ask("settings.workshop", undefined, null),
    restartWorkshop: (fresh) => ask<SettingsResult>("settings.restartWorkshop", { fresh }, SILENT),
    workshopOperation: () => ask<WorkshopOperation>("settings.workshopOperation", undefined, null),
    chooseDecisionModel: (model) => o.dispatch({ type: "chooseDecisionModel", model }),
    codexKeySaved: () => ask<boolean>("settings.codexKeySaved", undefined, false),
    setCodexKey: (key) => ask<SettingsResult>("settings.codexKey", { key }, SILENT),
    deleteCodexKey: () => ask<SettingsResult>("settings.codexKeyDelete", undefined, SILENT),
    amoAccount: () => ask<{ saved: boolean; issuer: string | null }>("settings.amoAccount", undefined, { saved: false, issuer: null }),
    setAmoAccount: (issuer, secret) => ask<SettingsResult>("settings.setAmoAccount", { issuer, secret }, SILENT),
    deleteAmoAccount: () => ask<SettingsResult>("settings.deleteAmoAccount", undefined, SILENT),
    chooseCodexEngine: (engine) => o.dispatch({ type: "chooseCodexEngine", engine }),
    claudeKeySaved: () => ask<boolean>("settings.claudeKeySaved", undefined, false),
    setClaudeKey: (key) => ask<SettingsResult>("settings.claudeKey", { key }, SILENT),
    deleteClaudeKey: () => ask<SettingsResult>("settings.claudeKeyDelete", undefined, SILENT),
    chooseClaudeEngine: (engine) => o.dispatch({ type: "chooseClaudeEngine", engine }),
    pullModel: (name) => ask<SettingsResult>("settings.pullModel", { name }, SILENT),
    pullProgress: () => ask<PullProgress | null>("settings.pullProgress", undefined, null),
    ollamaModels: (url) => ask("settings.ollamaModels", { url }, { ok: false as const, error: "Ollama ne répond pas à cette adresse." }),
    async grants() {
      const [sites, host, external] = await Promise.all([
        siteRows(),
        ask<GrantRow[]>("settings.grants", undefined, []),
        ask<{ clients: { id: string; name: string }[] } | null>("external.list", undefined, null),
      ]);
      const clients: GrantRow[] = (external?.clients ?? []).map((c) => ({ kind: "external", key: c.id, name: c.name, profile: null, detail: "Projets externes du mode design" }));
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
    deleteBackup: (path) => ask<SettingsResult>("settings.deleteBackup", { path }, SILENT),
    async exportData() {
      const to = await o.chrome.exportFolder();
      const r = await ask<{ ok: true; path: string } | { ok: false; error: string }>("settings.export", { to }, SILENT);
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
    version: async () => o.chrome.version(),
    openAdvanced: () => o.dispatch({ type: "openTab", windowId: o.windowId, url: "about:preferences", activate: true }),
    openNotificationSettings: () => o.chrome.openNotificationSettings(),
    openUrl(url) {
      if (typeof url === "string" && url.startsWith("https://")) o.dispatch({ type: "openTab", windowId: o.windowId, url, activate: true });
    },
  };
}
