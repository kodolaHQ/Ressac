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
