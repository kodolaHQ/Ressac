import { mkdirSync } from "node:fs";
import { watch } from "chokidar";
import type { CheminsEspace } from "../chemins.js";

const REGROUPEMENT_MS = 150;

/** Appelle `rappel` après chaque rafale de changements dans `accueil/`. Renvoie la fonction d'arrêt. */
export function surveillerAccueil(c: CheminsEspace, rappel: () => void): () => Promise<void> {
  mkdirSync(c.accueil, { recursive: true });
  let minuterie: NodeJS.Timeout | undefined;
  const observateur = watch(c.accueil, { ignoreInitial: true, ignored: (p) => p.endsWith(".tmp") });
  observateur.on("all", () => {
    clearTimeout(minuterie);
    minuterie = setTimeout(rappel, REGROUPEMENT_MS);
  });
  return async () => {
    clearTimeout(minuterie);
    await observateur.close();
  };
}
