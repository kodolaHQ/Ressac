import { readGrants, readSiteGrants } from "../../../packages/kernel/src/index.ts";
import type { LocalAi, Workshop } from "../../../packages/kernel/src/index.ts";
import type { LocalAiStateShown } from "../shared/api.ts";
import { deleteBackup, exportData, listBackups } from "./data-folder.ts";
import type { AgentAccount, DecisionModel, WorkshopOperation, GrantKind, GrantRow, SettingsResult } from "../shared/settings.ts";

// The settings page's host side: agent accounts, workshop, local AI, durable grants, data backups.

/** The agents that sign in inside the workshop; one more entry adds one more account row. */
export const AGENT_ACCOUNTS: {
  id: string;
  name: string;
  status: string[];
  logout: string[];
  parse(stdout: string): { loggedIn: boolean; account?: string };
}[] = [
  {
    id: "claude",
    name: "Claude Code",
    status: ["claude", "auth", "status", "--json"],
    logout: ["claude", "auth", "logout"],
    parse(stdout) {
      const j = JSON.parse(stdout) as { loggedIn?: unknown; email?: unknown };
      return { loggedIn: j.loggedIn === true, ...(typeof j.email === "string" ? { account: j.email } : {}) };
    },
  },
];

export const SETTINGS_METHODS = [
  "settings.agents",
  "settings.logout",
  "settings.workshop",
  "settings.restartWorkshop",
  "settings.workshopOperation",
  "settings.grants",
  "settings.revoke",
  "settings.backups",
  "settings.deleteBackup",
  "settings.export",
  "ai.state",
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
}

export function createSettingsHandlers(o: SettingsOptions): Record<(typeof SETTINGS_METHODS)[number], (p: any) => unknown> {
  /** The restart or rebuild in progress, whatever page or window asked for it. */
  let operation: WorkshopOperation = null;
  async function agents(): Promise<AgentAccount[]> {
    const state = await o.workshop.state();
    if (state === "docker-absent" || state === "absent" || state === "arrete")
      return AGENT_ACCOUNTS.map((a) => ({ id: a.id, name: a.name, state: state === "docker-absent" ? "docker-absent" : "no-container" }));
    return Promise.all(
      AGENT_ACCOUNTS.map(async (a): Promise<AgentAccount> => {
        try {
          const r = await o.workshop.exec(a.status);
          if (r.code !== 0) return { id: a.id, name: a.name, state: "error", error: tail(r.stderr) };
          const s = a.parse(r.stdout);
          return { id: a.id, name: a.name, state: s.loggedIn ? "logged-in" : "logged-out", ...(s.account ? { account: s.account } : {}) };
        } catch (e) {
          return { id: a.id, name: a.name, state: "error", error: failure(e) };
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

  return {
    "settings.agents": agents,
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
    "ai.state": async (): Promise<LocalAiStateShown> => {
      const v = await o.ai.check().catch(() => undefined);
      return { ...o.ai.state(), ...(v ? { verification: v } : {}), ollamaUrl: o.ai.ollamaUrl };
    },
    "ai.decisionModel": (p: { model?: DecisionModel }) => {
      if (p?.model === "kev" || p?.model === "pplx-decider-flash") o.ai.setDecisionModel(p.model === "kev" ? undefined : p.model);
    },
  };
}
