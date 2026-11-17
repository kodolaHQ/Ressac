import { listOllamaModels } from "./ollama-models.ts";
import { PULLABLE_MODELS, pullOllamaModel, UNSUPPORTED_MODEL } from "./ollama-pull.ts";
import { readGrants, readSiteGrants, type LlamaModel, type LocalAi, type Workshop, type WriterAgent } from "../../../packages/kernel/src/index.ts";
import type { LocalAiStateShown } from "../shared/api.ts";
import { startDeviceLogin } from "./device-login.ts";
import { INVALID_KEY, type AmoKeychain, type Keychain } from "./keychain.ts";
import { deleteBackup, exportData, listBackups } from "./data-folder.ts";
import { DECISION_MODEL, OLLAMA_ITSELF, SEARCH_MODEL, type AgentAccount, type LoginResult, type WorkshopOperation, type GrantKind, type GrantRow, type SettingsResult, type PullProgress } from "../shared/settings.ts";
import type { OllamaRuntime } from "./ollama-runtime.ts";
import type { DockerRuntime } from "./docker-runtime.ts";
import { hostSay } from "./locale.ts";

// The settings page's host side: agent accounts, workshop, local AI, durable grants, data backups.

/** The agents that sign in inside the workshop; one more entry adds one more account row. */
export const AGENT_ACCOUNTS: {
  id: string;
  name: string;
  status: string[];
  logout: string[];
  login: { kind: "panel" } | { kind: "device"; argv: string[]; origin: string };
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
    login: { kind: "device", argv: ["codex", "login", "--device-auth"], origin: "https://auth.openai.com" },
    parse({ stdout, stderr }) {
      const t = stdout + stderr;
      if (t.includes("Logged in using ChatGPT")) return { loggedIn: true, account: "ChatGPT" };
      if (t.includes("API key configured")) return { loggedIn: true, account: hostSay("host-account-api-key") };
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
  "settings.docker",
  "settings.startDocker",
  "settings.restartWorkshop",
  "settings.workshopOperation",
  "settings.grants",
  "settings.revoke",
  "settings.backups",
  "settings.deleteBackup",
  "settings.export",
  "ai.state",
  "ai.writer",
  "settings.pullModel",
  "settings.pullProgress",
  "settings.pullInBackground",
  "settings.startOllama",
] as const;

const KEY = /^[a-z0-9-]{1,100}$/;
const tail = (s: string) => s.trim().split("\n").slice(-3).join("\n").slice(-300);
const PULL_BUSY = () => hostSay("host-pull-busy");
const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface SettingsOptions {
  workshop: Pick<Workshop, "state" | "exec" | "restart" | "rebuild" | "secureNetwork">;
  /** Who writes (the account check is cached): reset whenever an account may have changed. */
  writer: { agent(): Promise<WriterAgent | null>; reset(): void };
  ai: Pick<LocalAi, "state" | "check" | "ollamaUrl" | "installDecisionModel" | "cancelInstall"> & { embed: Pick<LlamaModel, "install"> };
  ollama: Pick<OllamaRuntime, "status" | "start" | "install">;
  docker: DockerRuntime;
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
  /** A system notification (the end of a background model download). */
  notify(n: { title: string; text: string }): void;
  /** One of Ressac's own models finished downloading. */
  modelInstalled?(name: string): void;
}

/** How long a first agent session waits for a sign-in by code in progress. */
const LOGIN_WAIT_MS = 120_000;

export function createSettingsHandlers(o: SettingsOptions): Record<(typeof SETTINGS_METHODS)[number], (p: any) => unknown> & {
  stopLogins(): void;
  loginEnded(maxMs?: number): Promise<void>;
  /** Starts Ressac's own model downloads (d1, the search model), one after the other in the pull slot, unless a pull already runs (AI start, models missing). */
  downloadModels(names: string[]): void;
  /** Cancels those downloads (AI off); their partial files stay for the next try. */
  cancelDownloads(): void;
} {
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
  /** The last failed download of each llama-server model, cleared by a success; a cancel (AI off) is not a failure. */
  const modelErrors = new Map<string, string>();
  let cancelled = false;
  const installModel = async (name: string, install: (onPercent: (percent: number | null) => void) => Promise<void>) => {
    cancelled = false;
    try {
      await install((percent) => (pull = { name, percent, status: "" }));
      modelErrors.delete(name);
      o.modelInstalled?.(name);
    } catch (e) {
      if (!cancelled) modelErrors.set(name, failure(e));
      throw e;
    }
  };
  /** One model at a time, from any window; `pull` is set before the first await, so a second caller sees it. */
  let pulled: Promise<unknown> = Promise.resolve();
  const pullOne = (name: string): Promise<void> => {
    if (pull) return Promise.reject(new Error(PULL_BUSY()));
    pull = { name, percent: null, status: "" };
    const run = pullNow(name);
    pulled = run.catch(() => {});
    return run;
  };
  const pullNow = async (name: string) => {
    try {
      if (name === OLLAMA_ITSELF) await o.ollama.install((percent) => (pull = { name, percent, status: "" }));
      else if (name === DECISION_MODEL) await installModel(name, (p) => o.ai.installDecisionModel(p));
      else if (name === SEARCH_MODEL) await installModel(name, (p) => o.ai.embed.install(p));
      else await pullOllamaModel(o.ai.ollamaUrl, name, (e) => (pull = e));
    } finally {
      pull = null;
    }
  };
  /** Ressac's own models, downloaded at AI start. */
  const ressacModel = (name: string) => name === DECISION_MODEL || name === SEARCH_MODEL;
  /** Ressac's download chain at AI start, from its first model to its last. */
  let ressacPulls: Promise<void> | undefined;
  /** Ressac's downloads are not the user's: a user's pull waits for them instead of being refused. */
  const busy = () => !!pull && !ressacModel(pull.name);
  const afterRessac = async () => {
    while (ressacPulls || (pull && ressacModel(pull.name))) await (ressacPulls ?? pulled);
  };
  /** The restart or rebuild in progress, whatever page or window asked for it. */
  let operation: WorkshopOperation = null;
  async function agents(): Promise<AgentAccount[]> {
    // The poll of Réglages runs while an account is being signed in or out: the writer's cached check must not outlive it.
    o.writer.reset();
    // On every row, errors and a failed Docker probe included: one failed check does not end the sign-in, so the code stays shown.
    const signing = (a: (typeof AGENT_ACCOUNTS)[number]) => (a.login.kind === "device" && signIn ? { signingIn: true as const } : {});
    const state = await o.workshop.state();
    if (state === "docker-absent" || state === "absent" || state === "arrete")
      return AGENT_ACCOUNTS.map((a) => ({ id: a.id, name: a.name, login: a.login.kind, state: state === "docker-absent" ? "docker-absent" : "no-container", ...signing(a) }));
    return Promise.all(
      AGENT_ACCOUNTS.map(async (a): Promise<AgentAccount> => {
        try {
          const r = await o.workshop.exec(a.status);
          let s: ReturnType<typeof a.parse>;
          try {
            s = a.parse(r);
          } catch {
            return { id: a.id, name: a.name, login: a.login.kind, state: "error", error: tail(r.stderr || r.stdout), ...signing(a) };
          }
          return {
            id: a.id,
            name: a.name,
            login: a.login.kind,
            state: s.loggedIn ? "logged-in" : "logged-out",
            ...(s.account ? { account: s.account } : {}),
            ...signing(a),
          };
        } catch (e) {
          return { id: a.id, name: a.name, login: a.login.kind, state: "error", error: failure(e), ...signing(a) };
        }
      }),
    );
  }

  async function grants(): Promise<GrantRow[]> {
    const rows: GrantRow[] = [];
    for (const [kind, folder] of [["widget", o.widgetsFolder], ["action", o.actionsFolder]] as const) {
      const names = await o.names(kind);
      for (const [key, g] of Object.entries(await readGrants(folder)))
        rows.push({ kind, key, name: names[key] ?? key, profile: g.profile, detail: hostSay("host-grant-reads", { domains: g.domains.join(", ") }) });
    }
    const names = await o.names("siteApp");
    for (const key of Object.keys(await readSiteGrants(o.dataDir)))
      rows.push({ kind: "siteApp", key, name: names[key] ?? key, profile: null, detail: hostSay("host-grant-site-app") });
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
    // The sign-in runs as the agent's user: the sweep before a first session would kill it while the user types the code.
    // It waits for the sign-in, at most `maxMs` (abandoned, or stopped by a leftover process), then ends it: Réglages shows the error.
    loginEnded: async (maxMs = LOGIN_WAIT_MS) => {
      const s = signIn;
      if (!s) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([s.ended, new Promise((r) => (timer = setTimeout(r, maxMs)))]);
      clearTimeout(timer);
      if (signIn === s) stopLogins();
    },
    // A failure is kept in modelErrors (shown in Réglages) and the chain goes on to the next model.
    downloadModels: (names: string[]) => {
      if (pull || ressacPulls) return;
      cancelled = false;
      ressacPulls = (async () => {
        for (const n of names) if (!cancelled) await pullOne(n).catch(() => {});
      })().finally(() => (ressacPulls = undefined));
    },
    cancelDownloads: () => {
      cancelled = true;
      o.ai.cancelInstall();
    },
    "settings.agents": agents,
    "settings.login": async (p: { id?: unknown }): Promise<LoginResult> => {
      const a = AGENT_ACCOUNTS.find((x) => x.id === p?.id);
      if (!a) return { kind: "error", error: hostSay("host-unknown-agent") };
      if (a.login.kind === "panel") return { kind: "panel" };
      if ((await o.workshop.state()) !== "demarre") return { kind: "error", error: hostSay("host-workshop-not-started") };
      stopLogins();
      try {
        // The login runs the agent's CLI as node: never before the network rules are in place.
        await o.workshop.secureNetwork();
        const started = startDeviceLogin(o.deviceCommand(a.login.argv), { origin: a.login.origin });
        signIn = started;
        // Ended on its own (signed in, code expired) or stopped: Réglages then stops showing the code.
        void started.ended.then(() => {
          if (signIn === started) signIn = undefined;
        });
      } catch (e) {
        return { kind: "error", error: failure(e) };
      }
      const r = await signIn!.result;
      // A workshop built before Codex has no `codex` yet (docker exec: exit 127).
      if (r.kind === "error" && /executable file not found|command not found|codex: not found/.test(r.error)) return { kind: "error", error: hostSay("host-codex-missing") };
      return r;
    },
    "settings.codexKey": (p: { key?: unknown }) => keyResult("codex", async () => {
      if (typeof p?.key !== "string") throw new Error(INVALID_KEY());
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
        if (typeof p?.issuer !== "string" || typeof p?.secret !== "string") throw new Error(INVALID_KEY());
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
      if (typeof p?.key !== "string") throw new Error(INVALID_KEY());
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
    "settings.docker": () => o.docker.status(),
    "settings.startDocker": async (): Promise<SettingsResult> => {
      try {
        await o.docker.start();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: failure(e) };
      }
    },
    "settings.restartWorkshop": async (p: { fresh?: unknown }): Promise<SettingsResult> => {
      if (operation) return { ok: false, error: hostSay("host-workshop-busy") };
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
      if (busy()) return { ok: false, error: PULL_BUSY() };
      try {
        // Rechecked after the wait: of two d1 callers resuming together, the second finds the slot taken by the first and waits again.
        do await afterRessac(); while (ressacModel(String(p?.name)) && (ressacPulls || (pull && ressacModel(pull.name))));
        await pullOne(String(p?.name));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: failure(e) };
      }
    },
    // The welcome's download: answers at once, pulls one model after the other, and says the end in a notification.
    "settings.pullInBackground": (p: { names?: unknown }): SettingsResult => {
      if (busy()) return { ok: false, error: PULL_BUSY() };
      const names = Array.isArray(p?.names) ? p.names.map(String) : [];
      if (!names.length || names.some((n) => n !== OLLAMA_ITSELF && !ressacModel(n) && !PULLABLE_MODELS.includes(n))) return { ok: false, error: UNSUPPORTED_MODEL() };
      void (async () => {
        try {
          // A model of Ressac's installed meanwhile is a no-op for LocalAi; one that failed is tried again here.
          await afterRessac();
          for (const n of names) await pullOne(n);
          o.notify({ title: hostSay("host-ai-ready-title"), text: hostSay("host-ai-ready-text") });
        } catch (e) {
          o.notify({ title: hostSay("host-ai-failed-title"), text: hostSay("host-ai-failed-text", { reason: failure(e) }) });
        }
      })();
      return { ok: true };
    },
    "settings.pullProgress": () => pull,
    "settings.startOllama": async (): Promise<SettingsResult> => {
      try {
        await o.ollama.start();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: failure(e) };
      }
    },
    "ai.writer": async () => ({ agent: await o.writer.agent() }),
    "ai.state": async (): Promise<LocalAiStateShown> => {
      const v = await o.ai.check().catch(() => undefined);
      const ollama = await o.ollama.status().catch(() => undefined);
      const decisionError = modelErrors.get(DECISION_MODEL);
      const searchError = modelErrors.get(SEARCH_MODEL);
      const errors = { ...(decisionError ? { decisionError } : {}), ...(searchError ? { searchError } : {}) };
      return { ...o.ai.state(), ...(v ? { verification: v } : {}), ollamaUrl: o.ai.ollamaUrl, ...(ollama ? { ollama } : {}), ...errors };
    },
  };
}
