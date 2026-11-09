import { mkdirSync } from "node:fs";
import { watch } from "chokidar";
import type { SpacePaths } from "../paths.js";

const GROUPING_MS = 150;

/** Calls `rappel` after each burst of changes in these folders (created if missing). Returns the stop. */
function watchDirs(dossiers: string[], rappel: () => void): () => Promise<void> {
  for (const d of dossiers) mkdirSync(d, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  const observer = watch(dossiers, { ignoreInitial: true, ignored: (p) => p.endsWith(".tmp") || p.endsWith(".nouveau") });
  // Chokidar emits its errors rather than throwing them: without a listener, they would be lost.
  observer.on("error", (e) => console.error("[webaios] la surveillance des dossiers a échoué :", e));
  observer.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(rappel, GROUPING_MS);
  });
  return async () => {
    clearTimeout(timer);
    await observer.close();
  };
}

/** Calls `rappel` after each burst of changes in `accueil/`. Returns the stop function. */
export function watchHome(c: SpacePaths, rappel: () => void): () => Promise<void> {
  return watchDirs([c.accueil], rappel);
}

/** Calls `rappel` after each burst of changes in `actions/` or `composants/`. Returns the stop function. */
export function watchActions(c: SpacePaths, rappel: () => void): () => Promise<void> {
  return watchDirs([c.actions, c.composants], rappel);
}
