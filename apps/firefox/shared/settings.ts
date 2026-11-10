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
  account?: string;
  error?: string;
}
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
  "WebAiOs envoie à son développeur les plantages et les erreurs, sans adresse de page, pour corriger les bugs de la bêta. Un plantage peut contenir des fragments de mémoire.";

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
const modelField = z.string().regex(/^[\w.:\/@+-]{0,128}$/);
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
    if (u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return null;
  } catch {
    // falls through to the message
  }
  return "Adresse invalide (https://…)";
}
