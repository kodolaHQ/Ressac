import { listOllamaModels } from "./ollama-models.ts";
import { pullOllamaModel } from "./ollama-pull.ts";
import { readGrants, readSiteGrants } from "../../../packages/kernel/src/index.ts";
import type { LocalAi, Workshop } from "../../../packages/kernel/src/index.ts";
import type { LocalAiStateShown } from "../shared/api.ts";
import { startDeviceLogin } from "./device-login.ts";
import { INVALID_KEY, type AmoKeychain, type Keychain } from "./keychain.ts";
import { deleteBackup, exportData, listBackups } from "./data-folder.ts";
import type { AgentAccount, DecisionModel, LoginResult, WorkshopOperation, GrantKind, GrantRow, SettingsResult, PullProgress } from "../shared/settings.ts";

// The settings page's host side: agent accounts, workshop, local AI, durable grants, data backups.

/** The agents that sign in inside the workshop; one more entry adds one more account row. */
export const AGENT_ACCOUNTS: {
  id: string;
  name: string;
  status: string[];
  logout: string[];
  login: { kind: "panel" } | { kind: "device"; argv: string[] };
  /** Throws when the output is unreadable. */
  parse(r: { code: number; stdout: string; stderr: string }): { loggedIn: boolean; account?: string };
}[] = [
  {
    id: "claude",
    name: "Claude Code",
    status: ["claude", "auth", "status", "--json"],
    logout: ["claude", "auth", "logout"],
    login: { kind: "panel" },
    // `claude auth status` exits 1 when logged out but still prints its JSON: trust the JSON whatever the code.
    parse({ stdout }) {
      const j = JSON.parse(stdout) as { loggedIn?: unknown; email?: unknown };
      return { loggedIn: j.loggedIn === true, ...(typeof j.email === "string" ? { account: j.email } : {}) };
    },
  },
  {
    id: "codex",
    name: "Codex",
    status: ["codex", "login", "status"],
    logout: ["codex", "logout"],
    login: { kind: "device", argv: ["codex", "login", "--device-auth"] },
    parse({ stdout, stderr }) {
      const t = stdout + stderr;
      if (t.includes("Logged in using ChatGPT")) return { loggedIn: true, account: "ChatGPT" };
      if (t.includes("API key configured")) return { loggedIn: true, account: "clé d'API" };
      if (t.includes("Not logged in")) return { loggedIn: false };
      throw new Error(tail(t));
    },
  },
];

export const SETTINGS_METHODS = [
  "settings.agents",
  "settings.logout",
  "settings.login",
  "settings.codexKey",
  "settings.codexKeySaved",
  "settings.codexKeyDelete",
  "settings.amoAccount",
  "settings.setAmoAccount",
  "settings.deleteAmoAccount",
  "settings.claudeKey",
  "settings.claudeKeySaved",
  "settings.claudeKeyDelete",
  "settings.ollamaModels",
  "settings.workshop",
  "settings.restartWorkshop",
  "settings.workshopOperation",
  "settings.grants",
  "settings.revoke",
  "settings.backups",
  "settings.deleteBackup",
  "settings.export",
  "ai.state",
  "settings.pullModel",
  "settings.pullProgress",
  "ai.decisionModel",
] as const;

const KEY = /^[a-z0-9-]{1,100}$/;
const tail = (s: string) => s.trim().split("\n").slice(-3).join("\n").slice(-300);
const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface SettingsOptions {
  workshop: Pick<Workshop, "state" | "exec" | "restart" | "rebuild">;
  ai: Pick<LocalAi, "state" | "check" | "ollamaUrl" | "setDecisionModel">;
  stopApps(): Promise<void>;
  relaunchSessions(): Promise<void>;
  dataDir: string;
  widgetsFolder: string;
  actionsFolder: string;
  names(kind: "widget" | "action" | "siteApp"): Promise<Record<string, string>>;
  denyWidget(id: string): Promise<void>;
  denyAction(id: string): Promise<void>;
  revokeSite(id: string): Promise<void>;
  /** The command that runs `argv` in the workshop without a terminal. */
  deviceCommand(argv: string[]): string[];
  keychain: Keychain;
  claudeKeychain: Keychain;
  amoKeychain: AmoKeychain;
  /** Called after an agent's compatible API key is written or removed. */
  forgetKey(kind: "codex" | "claude"): void;
}

export function createSettingsHandlers(o: SettingsOptions): Record<(typeof SETTINGS_METHODS)[number], (p: any) => unknown> & { stopLogins(): void } {
  /** The sign-in by code in progress; one at a time. */
  let signIn: ReturnType<typeof startDeviceLogin> | undefined;
  const stopLogins = () => {
    signIn?.stop();
    signIn = undefined;
  };
  /**
   * The model download in progress, whatever window asked for it; one at a time.
   * shortcut: no cancel button in v1; quitting stops it and Ollama resumes from its kept chunks next time.
   */
  let pull: PullProgress | null = null;
  /** The restart or rebuild in progress, whatever page or window asked for it. */
  let operation: WorkshopOperation = null;
  async function agents(): Promise<AgentAccount[]> {
    const state = await o.workshop.state();
    if (state === "docker-absent" || state === "absent" || state === "arrete")
      return AGENT_ACCOUNTS.map((a) => ({ id: a.id, name: a.name, login: a.login.kind, state: state === "docker-absent" ? "docker-absent" : "no-container" }));
    return Promise.all(
      AGENT_ACCOUNTS.map(async (a): Promise<AgentAccount> => {
        try {
          const r = await o.workshop.exec(a.status);
          let s: ReturnType<typeof a.parse>;
          try {
            s = a.parse(r);
          } catch {
            return { id: a.id, name: a.name, login: a.login.kind, state: "error", error: tail(r.stderr || r.stdout) };
          }
          return { id: a.id, name: a.name, login: a.login.kind, state: s.loggedIn ? "logged-in" : "logged-out", ...(s.account ? { account: s.account } : {}) };
        } catch (e) {
          return { id: a.id, name: a.name, login: a.login.kind, state: "error", error: failure(e) };
        }
      }),
    );
  }

  async function grants(): Promise<GrantRow[]> {
    const rows: GrantRow[] = [];
    for (const [kind, folder] of [["widget", o.widgetsFolder], ["action", o.actionsFolder]] as const) {
      const names = await o.names(kind);
      for (const [key, g] of Object.entries(await readGrants(folder)))
        rows.push({ kind, key, name: names[key] ?? key, profile: g.profile, detail: `Lit avec votre compte : ${g.domains.join(", ")}` });
    }
    const names = await o.names("siteApp");
    for (const key of Object.keys(await readSiteGrants(o.dataDir)))
      rows.push({ kind: "siteApp", key, name: names[key] ?? key, profile: null, detail: "Retouches et lecture de l'appli accordées" });
    return rows;
  }

  const keyResult = async (kind: "codex" | "claude", change: () => Promise<void>): Promise<SettingsResult> => {
    try {
      await change();
      o.forgetKey(kind);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: failure(e) };
    }
  };

  return {
    stopLogins,
    "settings.agents": agents,
    "settings.login": async (p: { id?: unknown }): Promise<LoginResult> => {
      const a = AGENT_ACCOUNTS.find((x) => x.id === p?.id);
      if (!a) return { kind: "error", error: "Agent inconnu." };
      if (a.login.kind === "panel") return { kind: "panel" };
      if ((await o.workshop.state()) !== "demarre") return { kind: "error", error: "L'atelier de l'agent n'est pas démarré : voir Conteneur." };
      stopLogins();
      try {
        signIn = startDeviceLogin(o.deviceCommand(a.login.argv));
      } catch (e) {
        return { kind: "error", error: failure(e) };
      }
      const r = await signIn.result;
      // A workshop built before Codex has no `codex` yet (docker exec: exit 127).
      if (r.kind === "error" && /executable file not found|command not found|codex: not found/.test(r.error)) return { kind: "error", error: "Codex n'est pas encore installé dans l'atelier : ouvrez la vue agent ou redémarrez l'atelier (section Conteneur)." };
      return r;
    },
    "settings.codexKey": (p: { key?: unknown }) => keyResult("codex", async () => {
      if (typeof p?.key !== "string") throw new Error(INVALID_KEY);
      await o.keychain.write(p.key);
    }),
    "settings.codexKeySaved": () => o.keychain.has(),
    "settings.codexKeyDelete": () => keyResult("codex", () => o.keychain.remove()),
    "settings.amoAccount": async () => {
      const issuer = await o.amoKeychain.issuer();
      return { saved: issuer !== null, issuer };
    },
    "settings.setAmoAccount": async (p: { issuer?: unknown; secret?: unknown }): Promise<SettingsResult> => {
      try {
        if (typeof p?.issuer !== "string" || typeof p?.secret !== "string") throw new Error(INVALID_KEY);
        await o.amoKeychain.write(p.issuer, p.secret);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: failure(e) };
      }
    },
    "settings.deleteAmoAccount": async (): Promise<SettingsResult> => {
      try {
        await o.amoKeychain.remove();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: failure(e) };
      }
    },
    "settings.claudeKey": (p: { key?: unknown }) => keyResult("claude", async () => {
      if (typeof p?.key !== "string") throw new Error(INVALID_KEY);
      await o.claudeKeychain.write(p.key);
    }),
    "settings.claudeKeySaved": () => o.claudeKeychain.has(),
    "settings.claudeKeyDelete": () => keyResult("claude", () => o.claudeKeychain.remove()),
    "settings.ollamaModels": (p: { url?: unknown }) => (typeof p?.url === "string" ? listOllamaModels(p.url) : { ok: false, error: "Adresse invalide" }),
    "settings.logout": async (p: { id?: unknown }) => {
      const a = AGENT_ACCOUNTS.find((x) => x.id === p?.id);
      if (a) await o.workshop.exec(a.logout).catch((e) => console.error("[settings] logout:", e));
      return agents();
    },
    "settings.workshop": () => o.workshop.state(),
    "settings.restartWorkshop": async (p: { fresh?: unknown }): Promise<SettingsResult> => {
      if (operation) return { ok: false, error: "Une opération sur l'atelier est déjà en cours." };
      operation = p?.fresh === true ? "rebuild" : "restart";
      try {
        await o.stopApps();
        await (operation === "rebuild" ? o.workshop.rebuild() : o.workshop.restart());
        void o.relaunchSessions();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: failure(e) };
      } finally {
        operation = null;
      }
    },
    "settings.workshopOperation": () => operation,
    "settings.grants": grants,
    "settings.revoke": async (p: { kind?: unknown; key?: unknown }): Promise<void> => {
      if (typeof p?.key !== "string" || !KEY.test(p.key)) return;
      const k = p.kind as GrantKind;
      if (k === "widget") await o.denyWidget(p.key);
      else if (k === "action") await o.denyAction(p.key);
      else if (k === "siteApp") await o.revokeSite(p.key);
    },
    "settings.backups": () => listBackups(o.dataDir),
    "settings.deleteBackup": async (p: { path?: unknown }): Promise<SettingsResult> => {
      try {
        await deleteBackup(o.dataDir, String(p?.path));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: failure(e) };
      }
    },
    "settings.export": async (p: { to?: unknown }) => {
      try {
        return { ok: true as const, path: await exportData(o.dataDir, String(p?.to)) };
      } catch (e) {
        return { ok: false as const, error: failure(e) };
      }
    },
    "settings.pullModel": async (p: { name?: unknown }): Promise<SettingsResult> => {
      if (pull) return { ok: false, error: "Un téléchargement est déjà en cours" };
      const name = String(p?.name);
      pull = { name, percent: null, status: "" };
      try {
        await pullOllamaModel(o.ai.ollamaUrl, name, (e) => (pull = e));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: failure(e) };
      } finally {
        pull = null;
      }
    },
    "settings.pullProgress": () => pull,
    "ai.state": async (): Promise<LocalAiStateShown> => {
      const v = await o.ai.check().catch(() => undefined);
      return { ...o.ai.state(), ...(v ? { verification: v } : {}), ollamaUrl: o.ai.ollamaUrl };
    },
    "ai.decisionModel": (p: { model?: DecisionModel }) => {
      if (p?.model === "kev" || p?.model === "pplx-decider-flash") o.ai.setDecisionModel(p.model === "kev" ? undefined : p.model);
    },
  };
}
