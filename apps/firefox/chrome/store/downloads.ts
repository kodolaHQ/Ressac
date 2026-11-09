import type { Telechargement } from "../../shared/modele";

/** The fields of Firefox's Download that the list reads (pure: no Firefox global). */
export interface DownloadLike {
  target: { path: string };
  currentBytes: number;
  totalBytes: number;
  hasProgress: boolean;
  succeeded: boolean;
  canceled: boolean;
  error: unknown;
  stopped: boolean;
  startTime: Date;
}

/** succeeded → termine, error → interrompu (blocked files too), canceled → annule, else en-cours; total 0 without progress. */
export function toItem(id: string, d: DownloadLike): Telechargement {
  const etat = d.succeeded ? "termine" : d.error ? "interrompu" : d.canceled ? "annule" : "en-cours";
  return { id, nom: d.target.path.split(/[\\/]/).pop() ?? "", chemin: d.target.path, recus: d.currentBytes, total: d.hasProgress ? d.totalBytes : 0, etat };
}

export interface DownloadsList {
  /** Newest first (startTime). */
  list(): Telechargement[];
  onChange(cb: (l: Telechargement[]) => void): () => void;
  /** termine only: download.launch() with the system's app. */
  open(id: string): void;
  /** download.showContainingDirectory(). */
  show(id: string): void;
  /** en-cours only: download.cancel(). */
  cancel(id: string): void;
}

type FirefoxDownload = DownloadLike & { source?: { userContextId?: number }; finalize(removePartialData?: boolean): Promise<void>; launch(options?: { useSystemDefault?: boolean }): Promise<void>; showContainingDirectory(): Promise<void>; cancel(): Promise<void> };

/**
 * Follows Downloads.getList(Downloads.ALL) with addView; ids are crypto.randomUUID() kept in a WeakMap per Download.
 * A download from a container `refused` names is cancelled, its partial file removed, and dropped from the list.
 */
export async function createDownloads(refused: (userContextId: number) => boolean = () => false): Promise<DownloadsList> {
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  const downloads = new Set<FirefoxDownload>();
  const ids = new WeakMap<FirefoxDownload, string>();
  const listeners = new Set<(l: Telechargement[]) => void>();
  const idOf = (d: FirefoxDownload) => ids.get(d) ?? (ids.set(d, crypto.randomUUID()), ids.get(d)!);
  const list = () =>
    [...downloads].sort((a, b) => b.startTime.getTime() - a.startTime.getTime()).map((d) => toItem(idOf(d), d));
  // onDownloadChanged fires for every received chunk: one notification per microtask at most
  // (Promise.then: queueMicrotask callbacks did not run in this realm).
  let queued = false;
  const changed = () => {
    if (queued) return;
    queued = true;
    void Promise.resolve().then(() => {
      queued = false;
      const l = list();
      for (const cb of listeners) cb(l);
    });
  };
  const find = (id: string) => [...downloads].find((d) => ids.get(d) === id);
  const all = await Downloads.getList(Downloads.ALL);
  await all.addView({
    onDownloadAdded(d: FirefoxDownload) {
      if (refused(d.source?.userContextId ?? 0)) {
        void d
          .finalize(true)
          .then(() => all.remove(d))
          .catch((e: unknown) => console.error("[downloads]", e));
        return;
      }
      downloads.add(d);
      changed();
    },
    onDownloadChanged: changed,
    onDownloadRemoved(d: FirefoxDownload) {
      downloads.delete(d);
      changed();
    },
  });
  const fail = (e: unknown) => console.error("[downloads]", e);
  return {
    list,
    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    open(id) {
      const d = find(id);
      if (d?.succeeded) d.launch({ useSystemDefault: true }).catch(fail);
    },
    show(id) {
      find(id)?.showContainingDirectory().catch(fail);
    },
    cancel(id) {
      const d = find(id);
      if (d && !d.stopped) d.cancel().catch(fail);
    },
  };
}
