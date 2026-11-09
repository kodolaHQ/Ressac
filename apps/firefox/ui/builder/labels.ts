import type { Execution, ResumeExecution } from "@webaios/kernel";

/** Labels of a run, for the runs bar and a block's tab. */
export const TRIGGERS: Record<Execution["trigger"], string> = { planifiee: "Planifiée", manuelle: "Manuelle", agent: "Par l'agent", rejeu: "Essai" };
export const STATUSES: Record<Execution["status"], string> = {
  reussie: "Réussie",
  partielle: "Partielle",
  echouee: "Échouée",
  interrompue: "Interrompue",
  "accord-requis": "Accord requis",
};
/** Color of a run's badge: the same scale as the blocks. */
export const TINTS: Record<Execution["status"], "ok" | "moyen" | "echec"> = {
  reussie: "ok",
  partielle: "moyen",
  "accord-requis": "moyen",
  echouee: "echec",
  interrompue: "echec",
};

export const hour = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const date = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });

/** « 0,4 s », « 12 s », « 2 min 05 s »; « en cours » without an end. */
export function duration(start: string | null, end: string | null): string {
  if (!start) return "—";
  if (!end) return "en cours";
  const ms = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  if (ms < 10_000) return `${(ms / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** Output items: those of the `sortie` block (an implicit workflow's last block too). */
export function outputElements(e: ResumeExecution, output: string | undefined): number | null {
  const b = (output === undefined ? undefined : e.blocks.find((x) => x.id === output)) ?? e.blocks.at(-1);
  return b?.items ?? null;
}
