const deux = (n: number) => String(n).padStart(2, "0");
const MINUTE = 60_000;

/** « aujourd'hui HH:MM » ou « demain HH:MM » (jamais plus loin : une heure fixe revient au plus tard demain). */
function libelle(quand: Date, maintenant: Date): string {
  const memeJour = quand.toDateString() === maintenant.toDateString();
  return `${memeJour ? "aujourd'hui" : "demain"} ${deux(quand.getHours())}:${deux(quand.getMinutes())}`;
}

/**
 * La prochaine exécution d'un widget à heures fixes (« HH:MM », heure locale) après `maintenant` : « aujourd'hui 19:00 »
 * ou « demain 07:00 » ; null sans heures. L'heure de la minute en cours est passée (elle tourne déjà). Avec aussi une
 * fréquence (`minutes`), la plus proche des deux : `derniereMaj + minutes` (tout de suite si elle est passée ou sans
 * données).
 */
export function prochaineExecution(
  heures: readonly string[],
  maintenant: Date,
  frequence?: { minutes: number; derniereMaj: string | null },
): string | null {
  if (heures.length === 0) return null;
  const actuelle = `${deux(maintenant.getHours())}:${deux(maintenant.getMinutes())}`;
  // « HH:MM » sur deux chiffres : l'ordre des textes est celui des heures.
  const triees = [...heures].sort();
  const aujourdhui = triees.find((h) => h > actuelle);
  const [h, m] = (aujourdhui ?? triees[0]!).split(":").map(Number);
  const parHeure = new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate() + (aujourdhui ? 0 : 1), h, m);
  if (!frequence) return libelle(parHeure, maintenant);
  const derniere = frequence.derniereMaj ? Date.parse(frequence.derniereMaj) : NaN;
  const parFrequence = new Date(Number.isNaN(derniere) ? maintenant.getTime() : Math.max(maintenant.getTime(), derniere + frequence.minutes * MINUTE));
  // À la minute : la seconde n'est pas affichée.
  parFrequence.setSeconds(0, 0);
  return libelle(parFrequence < parHeure ? parFrequence : parHeure, maintenant);
}
