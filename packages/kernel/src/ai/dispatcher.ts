import type { LocalAi } from "./local-ai.js";

/** Local AI calls in flight at the same time, all runs together. */
export const AI_SIMULTANEOUS = 4;
/** Denial of a call from a finished run (abandoned, killed, kernel shutdown): it no longer goes to the AI. */
export const AI_ABANDONED = "Appel à l'IA abandonné : l'exécution est terminée";
/** Gemma called with `json: true` answered with a text that is not JSON (the layout then retries once). */
export const GEMMA_JSON_INVALID = "Gemma n'a pas rendu du JSON valide";

type AiAccess = Pick<LocalAi, "kev" | "gemma">;
/** `auDemarrage`: called when the call really goes to the AI. `signal` raised in the queue: denied without leaving; in flight: forwarded. */
export type AiCallOptions = { onStartup?: () => void; signal?: AbortSignal };
/** A run's view; `oublier` (at its end) denies its calls still queued and those that would come after. */
export type AiAccessRun = {
  kev(body: Parameters<LocalAi["kev"]>[0], o?: AiCallOptions): ReturnType<LocalAi["kev"]>;
  gemma(g: Parameters<LocalAi["gemma"]>[0], o?: AiCallOptions): ReturnType<LocalAi["gemma"]>;
  forget(): void;
};
export type AiDispatcher = { for(key: string, o?: { priority?: boolean }): AiAccessRun };

type Call = {
  launch: () => Promise<unknown>;
  ok: (v: unknown) => void;
  ko: (e: unknown) => void;
  onStartup?: () => void;
  /** Detaches the signal listener (at the call's departure or its denial). */
  detach: () => void;
};
type File = { priority: boolean; calls: Call[] };

/**
 * Serves local AI calls in turn between runs: each `cle` (a run) has its queue, and when
 * a slot frees up, it goes to the next queue that waits. A watch that chains calls therefore does not starve a short
 * widget. Priority queues (actions, launched on demand) that wait go before the others, in
 * turn among themselves; a call in flight is never interrupted. At most `simultanes` calls in flight; an error blocks
 * neither its queue nor the others.
 */
export function createAiDispatcher(ai: AiAccess, o: { concurrent?: number } = {}): AiDispatcher {
  const concurrent = o.concurrent ?? AI_SIMULTANEOUS;
  /** Pending calls, per run; a key with no pending call is no longer there. */
  const files = new Map<string, File>();
  /** The keys that wait, in the order they will be served: priority ones first. */
  const turns = { priority: [] as string[], normal: [] as string[] };
  const turnOf = (f: File) => (f.priority ? turns.priority : turns.normal);
  let inFlight = 0;

  const removeKey = (key: string, file: File) => {
    files.delete(key);
    const turn = turnOf(file);
    const i = turn.indexOf(key);
    if (i >= 0) turn.splice(i, 1);
  };

  const serve = () => {
    while (inFlight < concurrent && (turns.priority.length || turns.normal.length)) {
      const turn = turns.priority.length ? turns.priority : turns.normal;
      const key = turn.shift()!;
      const file = files.get(key)!;
      const call = file.calls.shift()!;
      if (file.calls.length) turn.push(key);
      else files.delete(key);
      call.detach();
      inFlight++;
      // `then` also catches an error thrown right away by the call.
      Promise.resolve()
        .then(() => {
          try {
            call.onStartup?.();
          } catch (e) {
            console.error("[webaios] départ d'un appel à l'IA :", e);
          }
          return call.launch();
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
        file = { priority: priority, calls: [] };
        files.set(key, file);
        turnOf(file).push(key);
      }
      const call: Call = { launch: launch, ok: ok as (v: unknown) => void, ko, onStartup: oa.onStartup, detach: () => {} };
      if (signal) {
        const abandon = () => {
          const f = files.get(key);
          const i = f ? f.calls.indexOf(call) : -1;
          if (f && i >= 0) {
            f.calls.splice(i, 1);
            if (!f.calls.length) removeKey(key, f);
          }
          ko(new Error(AI_ABANDONED));
        };
        signal.addEventListener("abort", abandon, { once: true });
        call.detach = () => signal.removeEventListener("abort", abandon);
      }
      file.calls.push(call);
      serve();
    });

  return {
    for: (key, op = {}) => {
      const priority = op.priority ?? false;
      let forgotten = false;
      const invoke = <T>(launch: () => Promise<T>, oa: AiCallOptions = {}): Promise<T> =>
        forgotten ? Promise.reject(new Error(AI_ABANDONED)) : put(key, priority, launch, oa);
      return {
        kev: (body, oa) => invoke(() => ai.kev(body, oa?.signal ? { signal: oa.signal } : undefined), oa),
        gemma: (g, oa) => invoke(() => ai.gemma(oa?.signal ? { ...g, signal: g.signal ? AbortSignal.any([g.signal, oa.signal]) : oa.signal } : g), oa),
        forget: () => {
          forgotten = true;
          const file = files.get(key);
          if (!file) return;
          removeKey(key, file);
          for (const a of file.calls) {
            a.detach();
            a.ko(new Error(AI_ABANDONED));
          }
        },
      };
    },
  };
}
