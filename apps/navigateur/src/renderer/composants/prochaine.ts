const deux = (n: number) => String(n).padStart(2, "0");

/**
 * La prochaine des heures fixes (« HH:MM », heure locale) après `maintenant` : « aujourd'hui 19:00 » ou « demain 07:00 » ;
 * null sans heures. L'heure de la minute en cours est passée (elle tourne déjà).
 */
export function prochaineExecution(heures: readonly string[], maintenant: Date): string | null {
  if (heures.length === 0) return null;
  const actuelle = `${deux(maintenant.getHours())}:${deux(maintenant.getMinutes())}`;
  // « HH:MM » sur deux chiffres : l'ordre des textes est celui des heures.
  const triees = [...heures].sort();
  const aujourdhui = triees.find((h) => h > actuelle);
  return aujourdhui ? `aujourd'hui ${aujourdhui}` : `demain ${triees[0]}`;
}
