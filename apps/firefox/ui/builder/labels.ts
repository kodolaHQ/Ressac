import type { Execution, ResumeExecution } from "@ressac/kernel";
import { t } from "../i18n.svelte";
import { appState } from "../state.svelte";

const locale = () => appState.value?.locale ?? "fr";

/** Labels of a run, for the runs bar and a block's tab. */
export const trigger = (x: Execution["trigger"]) => t(`builder-trigger-${x}`);
export const status = (x: Execution["status"]) => t(`builder-status-${x}`);
/** Color of a run's badge: the same scale as the blocks. */
export const TINTS: Record<Execution["status"], "ok" | "warn" | "bad"> = {
  succeeded: "ok",
  partial: "warn",
  "grant-required": "warn",
  failed: "bad",
  interrupted: "bad",
};

export const hour = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const date = (iso: string) => new Date(iso).toLocaleString(locale(), { dateStyle: "short", timeStyle: "medium" });

/** « 0,4 s », « 12 s », « 2 min 05 s »; « en cours » without an end. */
export function duration(start: string | null, end: string | null): string {
  if (!start) return "—";
  if (!end) return t("builder-duration-running");
  const ms = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  if (ms < 10_000) return `${(ms / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 })} s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** Output items: those of the `sortie` block (an implicit workflow's last block too). */
export function outputElements(e: ResumeExecution, output: string | undefined): number | null {
  const b = (output === undefined ? undefined : e.blocks.find((x) => x.id === output)) ?? e.blocks.at(-1);
  return b?.items ?? null;
}
