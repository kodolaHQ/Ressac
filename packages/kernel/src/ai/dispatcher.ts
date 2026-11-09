import type { LocalAi } from "./local-ai.js";

/** Local AI calls in flight at the same time, all runs together. */
export const AI_SIMULTANEOUS = 4;
/** Denial of a call from a finished run (abandoned, killed, kernel shutdown): it no longer goes to the AI. */
export const AI_ABANDONED = "Appel à l'IA abandonné : l'exécution est terminée";
/** Gemma called with `json: true` answered with a text that is not JSON (the layout then retries once). */
export const GEMMA_JSON_INVALID = "Gemma n'a pas rendu du JSON valide";

type AiAccess = Pick<LocalAi, "kev" | "gemma">;
/** `auDemarrage`: called when the call really goes to the AI. `signal` raised in the queue: denied without leaving; in flight: forwarded. */
export type AiCallOptions = { auDemarrage?: () => void; signal?: AbortSignal };
/** A run's view; `oublier` (at its end) denies its calls still queued and those that would come after. */
export type AiAccessRun = {
  kev(body: Parameters<LocalAi["kev"]>[0], o?: AiCallOptions): ReturnType<LocalAi["kev"]>;
  gemma(g: Parameters<LocalAi["gemma"]>[0], o?: AiCallOptions): ReturnType<LocalAi["gemma"]>;
  oublier(): void;
};
export type AiDispatcher = { pour(key: string, o?: { prioritaire?: boolean }): AiAccessRun };

type Call = {
  lancer: () => Promise<unknown>;
  ok: (v: unknown) => void;
  ko: (e: unknown) => void;
  auDemarrage?: () => void;
  /** Detaches the signal listener (at the call's departure or its denial). */
  detacher: () => void;
};
type File = { prioritaire: boolean; appels: Call[] };

/**
 * Serves local AI calls in turn between runs: each `cle` (a run) has its queue, and when
 * a slot frees up, it goes to the next queue that waits. A watch that chains calls therefore does not starve a short
 * widget. Priority queues (actions, launched on demand) that wait go before the others, in
 * turn among themselves; a call in flight is never interrupted. At most `simultanes` calls in flight; an error blocks
 * neither its queue nor the others.
 */
export function createAiDispatcher(ai: AiAccess, o: { simultanes?: number } = {}): AiDispatcher {
  const concurrent = o.simultanes ?? AI_SIMULTANEOUS;
  /** Pending calls, per run; a key with no pending call is no longer there. */
  const files = new Map<string, File>();
  /** The keys that wait, in the order they will be served: priority ones first. */
  const turns = { prioritaire: [] as string[], normal: [] as string[] };
  const turnOf = (f: File) => (f.prioritaire ? turns.prioritaire : turns.normal);
  let inFlight = 0;

  const removeKey = (key: string, file: File) => {
    files.delete(key);
    const turn = turnOf(file);
    const i = turn.indexOf(key);
    if (i >= 0) turn.splice(i, 1);
  };

  const serve = () => {
    while (inFlight < concurrent && (turns.prioritaire.length || turns.normal.length)) {
      const turn = turns.prioritaire.length ? turns.prioritaire : turns.normal;
      const key = turn.shift()!;
      const file = files.get(key)!;
      const call = file.appels.shift()!;
      if (file.appels.length) turn.push(key);
      else files.delete(key);
      call.detacher();
      inFlight++;
      // `then` also catches an error thrown right away by the call.
      Promise.resolve()
        .then(() => {
          try {
            call.auDemarrage?.();
          } catch (e) {
            console.error("[webaios] départ d'un appel à l'IA :", e);
          }
          return call.lancer();
        })
        .then(call.ok, call.ko)
        .finally(() => {
          inFlight--;
          serve();
        });
    }
  };

  const put = <T>(key: string, priority: boolean, launch: () => Promise<T>, oa: AiCallOptions): Promise<T> =>
    new Promise<T>((ok, ko) => {
      const signal = oa.signal;
      if (signal?.aborted) return ko(new Error(AI_ABANDONED));
      let file = files.get(key);
      if (!file) {
        file = { prioritaire: priority, appels: [] };
        files.set(key, file);
        turnOf(file).push(key);
      }
      const call: Call = { lancer: launch, ok: ok as (v: unknown) => void, ko, auDemarrage: oa.auDemarrage, detacher: () => {} };
      if (signal) {
        const abandon = () => {
          const f = files.get(key);
          const i = f ? f.appels.indexOf(call) : -1;
          if (f && i >= 0) {
            f.appels.splice(i, 1);
            if (!f.appels.length) removeKey(key, f);
          }
          ko(new Error(AI_ABANDONED));
        };
        signal.addEventListener("abort", abandon, { once: true });
        call.detacher = () => signal.removeEventListener("abort", abandon);
      }
      file.appels.push(call);
      serve();
    });

  return {
    pour: (key, op = {}) => {
      const priority = op.prioritaire ?? false;
      let forgotten = false;
      const invoke = <T>(launch: () => Promise<T>, oa: AiCallOptions = {}): Promise<T> =>
        forgotten ? Promise.reject(new Error(AI_ABANDONED)) : put(key, priority, launch, oa);
      return {
        kev: (body, oa) => invoke(() => ai.kev(body, oa?.signal ? { signal: oa.signal } : undefined), oa),
        gemma: (g, oa) => invoke(() => ai.gemma(oa?.signal ? { ...g, signal: g.signal ? AbortSignal.any([g.signal, oa.signal]) : oa.signal } : g), oa),
        oublier: () => {
          forgotten = true;
          const file = files.get(key);
          if (!file) return;
          removeKey(key, file);
          for (const a of file.appels) {
            a.detacher();
            a.ko(new Error(AI_ABANDONED));
          }
        },
      };
    },
  };
}
