import type { EtatWidget } from "../accueil/schemas.js";

/** Une heure fixe en échec est réessayée au plus tôt 15 min après la dernière tentative… */
export const REESSAI_HEURE_MS = 15 * 60_000;
/** … au plus 3 fois après le premier échec (4 tentatives par créneau), puis on attend l'heure suivante. */
export const REESSAIS_HEURE_MAX = 3;

export type SuiviHeures = NonNullable<EtatWidget["heures"]>;
/** Ce qu'une vraie exécution fait au suivi : réussie ou partielle, en échec, ou rien (interrompue, accord, atelier). */
export type IssueHeure = "reussie" | "echec" | "sans-effet";

const deux = (n: number) => String(n).padStart(2, "0");

/**
 * Le dernier créneau du jour (heure locale, « YYYY-MM-DDTHH:MM ») atteint à `maintenant`, ou null avant la première
 * heure : une heure manquée la veille n'est jamais rattrapée, et plusieurs heures manquées n'en font qu'une.
 */
export function creneauCourant(heures: readonly string[], maintenant: Date): string | null {
  const actuelle = `${deux(maintenant.getHours())}:${deux(maintenant.getMinutes())}`;
  // « HH:MM » sur deux chiffres : l'ordre des textes est celui des heures.
  const atteinte = heures.filter((h) => h <= actuelle).sort().at(-1);
  if (!atteinte) return null;
  return `${maintenant.getFullYear()}-${deux(maintenant.getMonth() + 1)}-${deux(maintenant.getDate())}T${atteinte}`;
}

/**
 * Le créneau courant reste-t-il à faire ? Pas s'il est déjà fait ; après un échec sur ce créneau, seulement 15 min
 * après la dernière tentative, et tant qu'il reste des réessais.
 */
export function heureDue(heures: readonly string[], suivi: EtatWidget["heures"], derniereTentative: string | null, maintenant: Date): boolean {
  const creneau = creneauCourant(heures, maintenant);
  if (!creneau || suivi?.faite === creneau) return false;
  if (suivi?.echecs?.heure !== creneau) return true;
  if (suivi.echecs.nombre > REESSAIS_HEURE_MAX) return false;
  return !derniereTentative || maintenant.getTime() - Date.parse(derniereTentative) >= REESSAI_HEURE_MS;
}

/**
 * Le suivi après une vraie exécution commencée dans le créneau `creneau`. Sans créneau (avant la première heure du
 * jour), rien ne change : le suivi de la veille n'est pas effacé.
 */
export function suiviApres(suivi: EtatWidget["heures"], creneau: string | null, issue: IssueHeure): SuiviHeures {
  const actuel: SuiviHeures = suivi ?? { faite: null, echecs: null };
  if (!creneau || issue === "sans-effet") return actuel;
  if (issue === "reussie") return { faite: creneau, echecs: null };
  const nombre = actuel.echecs?.heure === creneau ? actuel.echecs.nombre + 1 : 1;
  return { faite: actuel.faite, echecs: { heure: creneau, nombre } };
}
