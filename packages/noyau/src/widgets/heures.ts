import type { EtatWidget } from "../accueil/schemas.js";

/** A fixed hour that failed is retried at the earliest 15 min after the last attempt… */
export const REESSAI_HEURE_MS = 15 * 60_000;
/** … at most 3 times after the first failure (4 attempts per slot), then we wait for the next hour. */
export const REESSAIS_HEURE_MAX = 3;

export type SuiviHeures = NonNullable<EtatWidget["heures"]>;
/** What a real run does to the tracking: succeeded or partial, failed, or nothing (interrupted, grant, workshop). */
export type IssueHeure = "reussie" | "echec" | "sans-effet";

const deux = (n: number) => String(n).padStart(2, "0");

/**
 * The day's last slot (local time, « YYYY-MM-DDTHH:MM ») reached at `maintenant`, or null before the first
 * hour: an hour missed the day before is never caught up, and several missed hours count as one.
 */
export function creneauCourant(heures: readonly string[], maintenant: Date): string | null {
  const actuelle = `${deux(maintenant.getHours())}:${deux(maintenant.getMinutes())}`;
  // « HH:MM » on two digits: the order of the texts is that of the hours.
  const atteinte = heures.filter((h) => h <= actuelle).sort().at(-1);
  if (!atteinte) return null;
  return `${maintenant.getFullYear()}-${deux(maintenant.getMonth() + 1)}-${deux(maintenant.getDate())}T${atteinte}`;
}

/**
 * Does the current slot remain to be done? Not if it is already done; after a failure on this slot, only 15 min
 * after the last attempt, and as long as retries remain.
 */
export function heureDue(heures: readonly string[], suivi: EtatWidget["heures"], derniereTentative: string | null, maintenant: Date): boolean {
  const creneau = creneauCourant(heures, maintenant);
  // « YYYY-MM-DDTHH:MM » sorts like dates: a slot older than the one done (back to winter time,
  // hour added earlier in the day) is already covered.
  if (!creneau || (suivi?.faite != null && suivi.faite >= creneau)) return false;
  if (suivi?.echecs?.heure !== creneau) return true;
  if (suivi.echecs.nombre > REESSAIS_HEURE_MAX) return false;
  // Since the most recent of the end of the failure (a watch can last 30 min) and of the last attempt (an attempt
  // with no effect, interrupted, may have followed the failure).
  const reperes = [suivi.echecs.fin, derniereTentative].filter((x): x is string => !!x).map((x) => Date.parse(x));
  if (!reperes.length) return true;
  return maintenant.getTime() - Math.max(...reperes) >= REESSAI_HEURE_MS;
}

/**
 * The tracking after a real run started in slot `creneau` (and finished at `fin`, for a failure). Without a
 * slot (before the day's first hour), nothing changes: the previous day's tracking is not erased.
 */
export function suiviApres(suivi: EtatWidget["heures"], creneau: string | null, issue: IssueHeure, fin?: string): SuiviHeures {
  const actuel: SuiviHeures = suivi ?? { faite: null, echecs: null };
  if (!creneau || issue === "sans-effet") return actuel;
  if (issue === "reussie") {
    // The most recent slot done stays.
    if (actuel.faite != null && actuel.faite >= creneau) return actuel;
    return { faite: creneau, echecs: null };
  }
  const nombre = actuel.echecs?.heure === creneau ? actuel.echecs.nombre + 1 : 1;
  return { faite: actuel.faite, echecs: { heure: creneau, nombre, ...(fin ? { fin } : {}) } };
}
