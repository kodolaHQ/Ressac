import { z } from "zod";

/** Same syntax as the kernel's validDomain and the image's ressac-network.mjs (a test keeps them in agreement). */
export const MAX_AGENT_DOMAINS = 100;
export function validAgentDomain(d: unknown): d is string {
  if (typeof d !== "string" || d.length === 0 || d.length > 253) return false;
  const labels = (d.startsWith("*.") ? d.slice(2) : d).split(".");
  return labels.length >= 2 && labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l) && l.length <= 63) && !/^[0-9.]+$/.test(d.replace(/^\*\./, ""));
}

/**
 * A Mac of 8 GiB or less: a smaller machine, models unloaded sooner, and « Économiser la mémoire » on until the user
 * chooses. `force` (RESSAC_TEST_SMALL_MAC, tests): "1" or "0" overrides the memory.
 */
/**
 * Firefox's default-branch prefs « Économiser la mémoire » sets (live): one preallocated page process instead of 3,
 * background tabs unloadable under pressure after 3 min inactive instead of 10, and while pressure lasts the memory
 * watcher unloads one every second instead of every 10 (Firefox's defaults when off).
 */
export const memoryPrefs = (save: boolean) => ({
  "dom.ipc.processPrelaunch.fission.number": save ? 1 : 3,
  "browser.tabs.min_inactive_duration_before_unload": save ? 180_000 : 600_000,
  "browser.lowMemoryPollingIntervalMS": save ? 1_000 : 10_000,
});

export const isSmallMac = (totalBytes: number, force?: string | null) => (force === "1" || force === "0" ? force === "1" : totalBytes <= 8 * 2 ** 30);

/** Minutes an idle workshop machine keeps running before it stops (Réglages); the first is the default. */
export const MACHINE_IDLE_MINUTES = [5, 15, 30, 60] as const;
export type MachineIdleMinutes = (typeof MACHINE_IDLE_MINUTES)[number];
export const MachineIdleSchema = z.literal(MACHINE_IDLE_MINUTES);

/** The saved list: valid entries only, no duplicate, at most MAX_AGENT_DOMAINS. */
export const cleanAgentDomains = (list: unknown[]): string[] => [...new Set(list.filter(validAgentDomain))].slice(0, MAX_AGENT_DOMAINS);

export type Backup = { path: string; date: string; bytes: number };

/** The workshop restart or rebuild in progress, if any. */
export type WorkshopOperation = "restart" | "rebuild" | null;
export type AgentAccountState = "docker-absent" | "no-container" | "not-downloaded" | "logged-out" | "logged-in" | "error";
export interface AgentAccount {
  id: string;
  name: string;
  state: AgentAccountState;
  /** How the account signs in: Claude in a small terminal (the chat's login card), Codex by a code the host runs in the workshop. */
  login: "terminal" | "device";
  account?: string;
  error?: string;
  /** A sign-in by code is running in the workshop: absent once it ended (signed in, expired or stopped). */
  signingIn?: true;
}
export type LoginResult = { kind: "terminal" } | { kind: "device"; url: string; code: string } | { kind: "error"; error: string };
export type GrantKind = "site" | "widget" | "action" | "siteApp" | "external";
export interface GrantRow {
  kind: GrantKind;
  key: string;
  name: string;
  profile: string | null;
  detail: string;
}
export type SettingsResult = { ok: true } | { ok: false; error: string };

export type CodexEngineKind = "chatgpt" | "ollama" | "api";
export interface CodexEngine {
  kind: CodexEngineKind;
  ollamaUrl: string;
  ollamaModel: string;
  apiUrl: string;
  apiModel: string;
}
export const DEFAULT_CODEX_ENGINE: CodexEngine = {
  kind: "chatgpt",
  ollamaUrl: "http://host.docker.internal:11434",
  ollamaModel: "gpt-oss:20b",
  apiUrl: "",
  apiModel: "",
};

const httpUrl = (s: string) => {
  try {
    return /^https?:$/.test(new URL(s).protocol);
  } catch {
    return false;
  }
};
const urlField = z.string().max(2048).refine((s) => s === "" || httpUrl(s));
export const modelField = z.string().regex(/^([\w.:/@+][\w.:/@+-]{0,127})?$/);
export type ClaudeEngineKind = "subscription" | "ollama" | "api";
export interface ClaudeEngine {
  kind: ClaudeEngineKind;
  ollamaUrl: string;
  ollamaModel: string;
  apiUrl: string;
  apiModel: string;
}
export const DEFAULT_CLAUDE_ENGINE: ClaudeEngine = {
  kind: "subscription",
  ollamaUrl: "http://host.docker.internal:11434",
  ollamaModel: "",
  apiUrl: "",
  apiModel: "",
};
export const ClaudeEngineSchema: z.ZodType<ClaudeEngine> = z.object({
  kind: z.enum(["subscription", "ollama", "api"]),
  ollamaUrl: urlField,
  ollamaModel: modelField,
  apiUrl: urlField,
  apiModel: modelField,
});
export const CodexEngineSchema: z.ZodType<CodexEngine> = z.object({
  kind: z.enum(["chatgpt", "ollama", "api"]),
  ollamaUrl: urlField,
  ollamaModel: modelField,
  apiUrl: urlField,
  apiModel: modelField,
});

/** « Votre modèle »: the user's own model, driven by a loop in the host. Ollama is loopback only (host/own-model.ts). */
export interface OwnEngine {
  kind: "ollama" | "api";
  ollamaUrl: string;
  ollamaModel: string;
  apiUrl: string;
  apiModel: string;
}
export const DEFAULT_OWN_ENGINE: OwnEngine = { kind: "ollama", ollamaUrl: "http://127.0.0.1:11434", ollamaModel: "", apiUrl: "", apiModel: "" };
export const OwnEngineSchema: z.ZodType<OwnEngine> = z.object({
  kind: z.enum(["ollama", "api"]),
  ollamaUrl: urlField,
  ollamaModel: modelField,
  apiUrl: urlField,
  apiModel: modelField,
});

/** null when the address is https://, or http:// to this Mac (loopback, as `isOnMac` in host/own-model.ts): the key must not travel in clear over the network. */
export function apiUrlProblem(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.search && !u.hash && (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))) return null;
  } catch {
    // falls through to the message
  }
  return "Adresse invalide (https://…)";
}

/** What Ressac found of Docker on this machine. `stopped`: an app it can start (`app`: its name). `unmanaged`: under tests. */
export type DockerStatus = { kind: "ready" | "absent" | "unmanaged" } | { kind: "stopped"; app: string };
/** Ressac's workshop machine (host/machine.ts). */
export type MachineStatus =
  | { kind: "unsupported" | "stopped" | "starting" | "running" }
  /** `removed`: the user removed it; nothing installs it again before their « Installer la machine ». */
  | { kind: "absent"; removed?: true }
  | { kind: "downloading"; percent: number | null }
  /** `forceRemovable`: a damaged instance, or one whose logins cannot be exported: only a forced removal (logins lost) clears it. */
  | { kind: "error"; message: string; forceRemovable?: true };
/** What Réglages shows: `waiting` while the machine is ready but Docker's workshop still has sessions (it takes over after). */
export type MachineShown = MachineStatus & { waiting?: true };
/** The name the search model's download (EmbeddingGemma, run by llama-server for ⌘T Demander) goes under. */
export const SEARCH_MODEL = "embeddinggemma-300m";

/** The progress of one of Ressac's model downloads, shown in Settings. */
export interface PullProgress {
  name: string;
  /** 0-100, null without a total. */
  percent: number | null;
  status: string;
}
