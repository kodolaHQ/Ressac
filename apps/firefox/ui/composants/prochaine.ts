import type { EtatWidget } from "@webaios/noyau";

const deux = (n: number) => String(n).padStart(2, "0");
const MINUTE = 60_000;
// Copied from the scheduler (packages/noyau/src/widgets/heures.ts: REESSAI_HEURE_MS, REESSAIS_HEURE_MAX;
// planificateur.ts: REESSAI_ERREUR_MS): the rendering only imports types from the kernel.
/** A failure is retried at the earliest 15 min after the last attempt (or the end of the failure, for a fixed hour). */
const REESSAI_MS = 15 * MINUTE;
/** At most 3 retries at a fixed hour after its first failure. */
const REESSAIS_HEURE_MAX = 3;

/** What « prochaine » reads from the widget's state: the scheduler's rules after a failure. */
export type EtatProchaine = Pick<EtatWidget, "statut" | "derniereTentative" | "heures">;

/** « aujourd'hui HH:MM » or « demain HH:MM » (never further: a fixed hour comes back tomorrow at the latest). */
function libelle(quand: Date, maintenant: Date): string {
  const memeJour = quand.toDateString() === maintenant.toDateString();
  return `${memeJour ? "aujourd'hui" : "demain"} ${deux(quand.getHours())}:${deux(quand.getMinutes())}`;
}

const instant = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * The retry of the failed fixed hour of the current slot, like `heureDue` (heures.ts): 15 min after the later of the
 * end of the failure and the last attempt, as long as retries remain and only the same day (yesterday's slot is
 * never caught up). Null with no retry to come.
 */
function reessaiHeure(heures: readonly string[], maintenant: Date, etat: EtatProchaine | undefined): Date | null {
  const suivi = etat?.heures;
  if (!etat || !suivi?.echecs) return null;
  const actuelle = `${deux(maintenant.getHours())}:${deux(maintenant.getMinutes())}`;
  const atteinte = heures.filter((h) => h <= actuelle).sort().at(-1);
  if (!atteinte) return null;
  const creneau = `${maintenant.getFullYear()}-${deux(maintenant.getMonth() + 1)}-${deux(maintenant.getDate())}T${atteinte}`;
  if (suivi.faite != null && suivi.faite >= creneau) return null;
  if (suivi.echecs.heure !== creneau || suivi.echecs.nombre > REESSAIS_HEURE_MAX) return null;
  const reperes = [suivi.echecs.fin, etat.derniereTentative].map(instant).filter((t) => !Number.isNaN(t));
  const quand = new Date(Math.max(maintenant.getTime(), ...reperes.map((t) => t + REESSAI_MS)));
  return quand.toDateString() === maintenant.toDateString() ? quand : null;
}

/**
 * The next run of a fixed-hours widget (« HH:MM », local time) after `maintenant`: « aujourd'hui 19:00 » or
 * « demain 07:00 »; null without hours. The current minute's hour is past (it is already running). With a
 * frequency (`minutes`) too, the nearer of the two: `derniereMaj + minutes` (right away if it is past or without
 * data). With `etat`, the scheduler's rules after a failure: the frequency of a widget in error also waits 15 min
 * since the last attempt, and a failed fixed hour is retried (see `reessaiHeure`).
 */
export function prochaineExecution(
  heures: readonly string[],
  maintenant: Date,
  frequence?: { minutes: number; derniereMaj: string | null },
  etat?: EtatProchaine,
): string | null {
  if (heures.length === 0) return null;
  const actuelle = `${deux(maintenant.getHours())}:${deux(maintenant.getMinutes())}`;
  // « HH:MM » on two digits: the order of the texts is the order of the hours.
  const triees = [...heures].sort();
  const aujourdhui = triees.find((h) => h > actuelle);
  const [h, m] = (aujourdhui ?? triees[0]!).split(":").map(Number);
  let prochaine = new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate() + (aujourdhui ? 0 : 1), h, m);
  const reessai = reessaiHeure(heures, maintenant, etat);
  if (reessai && reessai < prochaine) {
    prochaine = reessai;
    // To the minute: the second is not shown.
    prochaine.setSeconds(0, 0);
  }
  if (!frequence) return libelle(prochaine, maintenant);
  const reperes = [maintenant.getTime()];
  const derniere = instant(frequence.derniereMaj);
  if (!Number.isNaN(derniere)) reperes.push(derniere + frequence.minutes * MINUTE);
  const tentative = instant(etat?.derniereTentative);
  if (etat?.statut === "erreur" && !Number.isNaN(tentative)) reperes.push(tentative + REESSAI_MS);
  const parFrequence = new Date(Math.max(...reperes));
  // To the minute: the second is not shown.
  parFrequence.setSeconds(0, 0);
  return libelle(parFrequence < prochaine ? parFrequence : prochaine, maintenant);
}
