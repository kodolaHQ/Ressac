export type Backup = { path: string; date: string; bytes: number };

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
