// Errors that the interpreter recognizes in the per-item loop.

/**
 * Thrown for an item the kernel refused to run (search cap, searches stopped): the item stays
 * without the field and the block ends "partial", but it is never a failure (`onError: "fail"` does not make the
 * block fail). In simple mode, it is an ordinary error.
 */
export class ItemNotRun extends Error {}

/** Kernel messages that mean "not run" (copied from src/workflows/access.ts, a test checks they are equal). */
export const NOT_RUN_MESSAGES = Object.freeze([
  "Plafond de recherches atteint (30 par exécution)",
  "Recherches arrêtées : DuckDuckGo a refusé une recherche de cette exécution",
]);
