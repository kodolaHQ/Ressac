import { z } from "zod";

export type Backup = { path: string; date: string; bytes: number };

/** The workshop restart or rebuild in progress, if any. */
export type WorkshopOperation = "restart" | "rebuild" | null;
export type DecisionModel = "pplx-decider-flash" | "kev";
export type AgentAccountState = "docker-absent" | "no-container" | "logged-out" | "logged-in" | "error";
export interface AgentAccount {
  id: string;
  name: string;
  state: AgentAccountState;
  /** How the account signs in: Claude in a terminal panel, Codex by a code the host runs in the workshop. */
  login: "panel" | "device";
  account?: string;
  error?: string;
}
export type LoginResult = { kind: "panel" } | { kind: "device"; url: string; code: string } | { kind: "error"; error: string };
export type GrantKind = "site" | "widget" | "action" | "siteApp" | "external";
export interface GrantRow {
  kind: GrantKind;
  key: string;
  name: string;
  profile: string | null;
  detail: string;
}
export type SettingsResult = { ok: true } | { ok: false; error: string };

/** The one-time notice about error reports, also the Settings switch's description. */
export const TELEMETRY_NOTICE =
  "Ressac envoie à son développeur les plantages et les erreurs, sans adresse de page, pour corriger les bugs de la bêta, et à chaque lancement un identifiant d'installation anonyme pour compter les utilisateurs. Un plantage peut contenir des fragments de mémoire.";

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
export const modelField = z.string().regex(/^([\w.:\/@+][\w.:\/@+-]{0,127})?$/);
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

/** null when the address is https://, or http:// to this Mac (the key must not travel in clear over the network). */
export function apiUrlProblem(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.search && !u.hash && (u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")))) return null;
  } catch {
    // falls through to the message
  }
  return "Adresse invalide (https://…)";
}

/** What Ressac found of Docker on this machine. `stopped`: an app it can start (`app`: its name). `unmanaged`: under tests. */
export type DockerStatus = { kind: "ready" | "absent" | "unmanaged" } | { kind: "stopped"; app: string };
/** What Ressac found of Ollama on this machine. `unmanaged`: another address is imposed, Ressac starts and installs nothing. */
export type OllamaStatus = { kind: "ready"; version: string } | { kind: "outdated"; version: string; min: string } | { kind: "stopped" | "absent" | "unmanaged" };
/** The name the download of Ollama itself goes under, next to the model names. */
export const OLLAMA_ITSELF = "ollama";

/** The progress of an Ollama model download (or of Ollama itself) shown in Settings. */
export interface PullProgress {
  name: string;
  /** 0-100, null while Ollama gives no total (manifest, verifying). */
  percent: number | null;
  status: string;
}
