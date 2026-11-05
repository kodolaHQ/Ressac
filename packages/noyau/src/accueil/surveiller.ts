import { mkdirSync } from "node:fs";
import { watch } from "chokidar";
import type { CheminsEspace } from "../chemins.js";

const REGROUPEMENT_MS = 150;

/** Appelle `rappel` après chaque rafale de changements dans ces dossiers (créés s'ils manquent). Renvoie l'arrêt. */
function surveiller(dossiers: string[], rappel: () => void): () => Promise<void> {
  for (const d of dossiers) mkdirSync(d, { recursive: true });
  let minuterie: NodeJS.Timeout | undefined;
  const observateur = watch(dossiers, { ignoreInitial: true, ignored: (p) => p.endsWith(".tmp") || p.endsWith(".nouveau") });
  // Chokidar émet ses erreurs plutôt que de les lancer : sans écouteur, elles seraient perdues.
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

/** Appelle `rappel` après chaque rafale de changements dans `accueil/`. Renvoie la fonction d'arrêt. */
export function surveillerAccueil(c: CheminsEspace, rappel: () => void): () => Promise<void> {
  return surveiller([c.accueil], rappel);
}

/** Appelle `rappel` après chaque rafale de changements dans `actions/` ou `composants/`. Renvoie la fonction d'arrêt. */
export function surveillerActions(c: CheminsEspace, rappel: () => void): () => Promise<void> {
  return surveiller([c.actions, c.composants], rappel);
}
