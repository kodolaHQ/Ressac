import type { EtatWidget } from "@webaios/noyau";

const deux = (n: number) => String(n).padStart(2, "0");
const MINUTE = 60_000;
// Recopiés du planificateur (packages/noyau/src/widgets/heures.ts : REESSAI_HEURE_MS, REESSAIS_HEURE_MAX ;
// planificateur.ts : REESSAI_ERREUR_MS) : le rendu n'importe que des types du noyau.
/** Un échec est réessayé au plus tôt 15 min après la dernière tentative (ou la fin de l'échec, pour une heure). */
const REESSAI_MS = 15 * MINUTE;
/** Au plus 3 réessais d'une heure fixe après son premier échec. */
const REESSAIS_HEURE_MAX = 3;

/** Ce que « prochaine » lit de l'état du widget : les règles du planificateur après un échec. */
export type EtatProchaine = Pick<EtatWidget, "statut" | "derniereTentative" | "heures">;

/** « aujourd'hui HH:MM » ou « demain HH:MM » (jamais plus loin : une heure fixe revient au plus tard demain). */
function libelle(quand: Date, maintenant: Date): string {
  const memeJour = quand.toDateString() === maintenant.toDateString();
  return `${memeJour ? "aujourd'hui" : "demain"} ${deux(quand.getHours())}:${deux(quand.getMinutes())}`;
}

const instant = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * Le réessai de l'heure fixe en échec du créneau en cours, comme `heureDue` (heures.ts) : 15 min après le plus récent
 * de la fin de l'échec et de la dernière tentative, tant qu'il reste des réessais et seulement le jour même (un
 * créneau d'hier n'est jamais rattrapé). Null sans réessai à venir.
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
 * La prochaine exécution d'un widget à heures fixes (« HH:MM », heure locale) après `maintenant` : « aujourd'hui 19:00 »
 * ou « demain 07:00 » ; null sans heures. L'heure de la minute en cours est passée (elle tourne déjà). Avec aussi une
 * fréquence (`minutes`), la plus proche des deux : `derniereMaj + minutes` (tout de suite si elle est passée ou sans
 * données). Avec `etat`, les règles du planificateur après un échec : la fréquence d'un widget en erreur attend en
 * plus 15 min depuis la dernière tentative, et une heure fixe en échec est réessayée (voir `reessaiHeure`).
 */
export function prochaineExecution(
  heures: readonly string[],
  maintenant: Date,
  frequence?: { minutes: number; derniereMaj: string | null },
  etat?: EtatProchaine,
): string | null {
  if (heures.length === 0) return null;
  const actuelle = `${deux(maintenant.getHours())}:${deux(maintenant.getMinutes())}`;
  // « HH:MM » sur deux chiffres : l'ordre des textes est celui des heures.
  const triees = [...heures].sort();
  const aujourdhui = triees.find((h) => h > actuelle);
  const [h, m] = (aujourdhui ?? triees[0]!).split(":").map(Number);
  let prochaine = new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate() + (aujourdhui ? 0 : 1), h, m);
  const reessai = reessaiHeure(heures, maintenant, etat);
  if (reessai && reessai < prochaine) {
    prochaine = reessai;
    // À la minute : la seconde n'est pas affichée.
    prochaine.setSeconds(0, 0);
  }
  if (!frequence) return libelle(prochaine, maintenant);
  const reperes = [maintenant.getTime()];
  const derniere = instant(frequence.derniereMaj);
  if (!Number.isNaN(derniere)) reperes.push(derniere + frequence.minutes * MINUTE);
  const tentative = instant(etat?.derniereTentative);
  if (etat?.statut === "erreur" && !Number.isNaN(tentative)) reperes.push(tentative + REESSAI_MS);
  const parFrequence = new Date(Math.max(...reperes));
  // À la minute : la seconde n'est pas affichée.
  parFrequence.setSeconds(0, 0);
  return libelle(parFrequence < prochaine ? parFrequence : prochaine, maintenant);
}
