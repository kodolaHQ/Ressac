import { mkdirSync } from "node:fs";
import { watch } from "chokidar";
import type { SpacePaths } from "../paths.js";

const GROUPING_MS = 150;

/** Calls `rappel` after each burst of changes in these folders (created if missing). Returns the stop. */
function watchDirs(folders: string[], callback: () => void): () => Promise<void> {
  for (const d of folders) mkdirSync(d, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  const observer = watch(folders, { ignoreInitial: true, ignored: (p) => p.endsWith(".tmp") || p.endsWith(".nouveau") });
  // Chokidar emits its errors rather than throwing them: without a listener, they would be lost.
  observer.on("error", (e) => console.error("[ressac] the folder watch failed:", e));
  observer.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(callback, GROUPING_MS);
  });
  return async () => {
    clearTimeout(timer);
    await observer.close();
  };
}

/** Calls `rappel` after each burst of changes in `home/`. Returns the stop function. */
export function watchHome(c: SpacePaths, callback: () => void): () => Promise<void> {
  return watchDirs([c.home], callback);
}

/** Calls `rappel` after each burst of changes in `actions/` or `components/`. Returns the stop function. */
export function watchActions(c: SpacePaths, callback: () => void): () => Promise<void> {
  return watchDirs([c.actions, c.components], callback);
}
