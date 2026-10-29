// Erreurs que l'interpréteur reconnaît dans la boucle par élément.

/**
 * Levée pour un élément que le noyau a refusé de lancer (plafond de recherches, recherches arrêtées) : l'élément reste
 * sans champ et le bloc finit « partiel », mais ce n'est jamais un échec (`siErreur: "echouer"` ne fait pas échouer le
 * bloc). En mode simple, c'est une erreur ordinaire.
 */
export class ElementNonLance extends Error {}

/** Messages du noyau qui veulent dire « non lancé » (recopiés de src/workflows/acces.ts, un test vérifie l'égalité). */
export const MESSAGES_NON_LANCE = Object.freeze([
  "Plafond de recherches atteint (30 par exécution)",
  "Recherches arrêtées : DuckDuckGo a refusé une recherche de cette exécution",
]);
