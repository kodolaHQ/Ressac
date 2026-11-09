import type { Execution, ResumeExecution } from "@webaios/kernel";

/** Labels of a run, for the runs bar and a block's tab. */
export const TRIGGERS: Record<Execution["declencheur"], string> = { planifiee: "Planifiée", manuelle: "Manuelle", agent: "Par l'agent", rejeu: "Essai" };
export const STATUSES: Record<Execution["statut"], string> = {
  reussie: "Réussie",
  partielle: "Partielle",
  echouee: "Échouée",
  interrompue: "Interrompue",
  "accord-requis": "Accord requis",
};
/** Color of a run's badge: the same scale as the blocks. */
export const TINTS: Record<Execution["statut"], "ok" | "moyen" | "echec"> = {
  reussie: "ok",
  partielle: "moyen",
  "accord-requis": "moyen",
  echouee: "echec",
  interrompue: "echec",
};

export const hour = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const date = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });

/** « 0,4 s », « 12 s », « 2 min 05 s »; « en cours » without an end. */
export function duration(debut: string | null, fin: string | null): string {
  if (!debut) return "—";
  if (!fin) return "en cours";
  const ms = Math.max(0, new Date(fin).getTime() - new Date(debut).getTime());
  if (ms < 10_000) return `${(ms / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** Output items: those of the `sortie` block (an implicit workflow's last block too). */
export function elementsEnSortie(e: ResumeExecution, sortie: string | undefined): number | null {
  const b = (sortie === undefined ? undefined : e.blocs.find((x) => x.id === sortie)) ?? e.blocs.at(-1);
  return b?.elements ?? null;
}
