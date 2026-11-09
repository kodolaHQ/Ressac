import { mkdirSync } from "node:fs";
import { watch } from "chokidar";
import type { CheminsEspace } from "../chemins.js";

const REGROUPEMENT_MS = 150;

/** Calls `rappel` after each burst of changes in these folders (created if missing). Returns the stop. */
function surveiller(dossiers: string[], rappel: () => void): () => Promise<void> {
  for (const d of dossiers) mkdirSync(d, { recursive: true });
  let minuterie: NodeJS.Timeout | undefined;
  const observateur = watch(dossiers, { ignoreInitial: true, ignored: (p) => p.endsWith(".tmp") || p.endsWith(".nouveau") });
  // Chokidar emits its errors rather than throwing them: without a listener, they would be lost.
  observateur.on("error", (e) => console.error("[webaios] la surveillance des dossiers a échoué :", e));
  observateur.on("all", () => {
    clearTimeout(minuterie);
    minuterie = setTimeout(rappel, REGROUPEMENT_MS);
  });
  return async () => {
    clearTimeout(minuterie);
    await observateur.close();
  };
}

/** Calls `rappel` after each burst of changes in `accueil/`. Returns the stop function. */
export function surveillerAccueil(c: CheminsEspace, rappel: () => void): () => Promise<void> {
  return surveiller([c.accueil], rappel);
}

/** Calls `rappel` after each burst of changes in `actions/` or `composants/`. Returns the stop function. */
export function surveillerActions(c: CheminsEspace, rappel: () => void): () => Promise<void> {
  return surveiller([c.actions, c.composants], rappel);
}
