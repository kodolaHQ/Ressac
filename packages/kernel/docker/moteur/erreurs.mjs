// Errors that the interpreter recognizes in the per-item loop.

/**
 * Thrown for an item the kernel refused to run (search cap, searches stopped): the item stays
 * without the field and the block ends "partiel", but it is never a failure (`siErreur: "echouer"` does not make the
 * block fail). In simple mode, it is an ordinary error.
 */
export class ElementNonLance extends Error {}

/** Kernel messages that mean "not run" (copied from src/workflows/acces.ts, a test checks they are equal). */
export const MESSAGES_NON_LANCE = Object.freeze([
  "Plafond de recherches atteint (30 par exécution)",
  "Recherches arrêtées : DuckDuckGo a refusé une recherche de cette exécution",
]);
