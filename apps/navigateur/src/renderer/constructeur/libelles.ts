import type { Execution, ResumeExecution } from "@webaios/noyau";

/** Libellés d'une exécution, pour la barre des exécutions et l'onglet d'un bloc. */
export const DECLENCHEURS: Record<Execution["declencheur"], string> = { planifiee: "Planifiée", manuelle: "Manuelle", agent: "Par l'agent", rejeu: "Essai" };
export const STATUTS: Record<Execution["statut"], string> = {
  reussie: "Réussie",
  partielle: "Partielle",
  echouee: "Échouée",
  interrompue: "Interrompue",
  "accord-requis": "Accord requis",
};
/** Couleur de la pastille d'une exécution : la même échelle que les blocs. */
export const TEINTES: Record<Execution["statut"], "ok" | "moyen" | "echec"> = {
  reussie: "ok",
  partielle: "moyen",
  "accord-requis": "moyen",
  echouee: "echec",
  interrompue: "echec",
};

export const heure = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const date = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });

/** « 0,4 s », « 12 s », « 2 min 05 s » ; « en cours » sans fin. */
export function duree(debut: string | null, fin: string | null): string {
  if (!debut) return "—";
  if (!fin) return "en cours";
  const ms = Math.max(0, new Date(fin).getTime() - new Date(debut).getTime());
  if (ms < 10_000) return `${(ms / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** Éléments en sortie : ceux du bloc `sortie` (le dernier bloc d'un workflow implicite aussi). */
export function elementsEnSortie(e: ResumeExecution, sortie: string | undefined): number | null {
  const b = (sortie === undefined ? undefined : e.blocs.find((x) => x.id === sortie)) ?? e.blocs.at(-1);
  return b?.elements ?? null;
}
