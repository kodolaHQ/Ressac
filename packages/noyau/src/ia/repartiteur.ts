import type { IaLocale } from "./ia-locale.js";

/** Local AI calls in flight at the same time, all runs together. */
export const IA_SIMULTANES = 4;
/** Denial of a call from a finished run (abandoned, killed, kernel shutdown): it no longer goes to the AI. */
export const IA_ABANDONNEE = "Appel à l'IA abandonné : l'exécution est terminée";
/** Gemma called with `json: true` answered with a text that is not JSON (the layout then retries once). */
export const GEMMA_JSON_INVALIDE = "Gemma n'a pas rendu du JSON valide";

type AccesIa = Pick<IaLocale, "kev" | "gemma">;
/** `auDemarrage`: called when the call really goes to the AI. `signal` raised in the queue: denied without leaving; in flight: forwarded. */
export type OptionsAppelIa = { auDemarrage?: () => void; signal?: AbortSignal };
/** A run's view; `oublier` (at its end) denies its calls still queued and those that would come after. */
export type AccesIaExecution = {
  kev(corps: Parameters<IaLocale["kev"]>[0], o?: OptionsAppelIa): ReturnType<IaLocale["kev"]>;
  gemma(g: Parameters<IaLocale["gemma"]>[0], o?: OptionsAppelIa): ReturnType<IaLocale["gemma"]>;
  oublier(): void;
};
export type RepartiteurIa = { pour(cle: string, o?: { prioritaire?: boolean }): AccesIaExecution };

type Appel = {
  lancer: () => Promise<unknown>;
  ok: (v: unknown) => void;
  ko: (e: unknown) => void;
  auDemarrage?: () => void;
  /** Detaches the signal listener (at the call's departure or its denial). */
  detacher: () => void;
};
type File = { prioritaire: boolean; appels: Appel[] };

/**
 * Serves local AI calls in turn between runs: each `cle` (a run) has its queue, and when
 * a slot frees up, it goes to the next queue that waits. A watch that chains calls therefore does not starve a short
 * widget. Priority queues (actions, launched on demand) that wait go before the others, in
 * turn among themselves; a call in flight is never interrupted. At most `simultanes` calls in flight; an error blocks
 * neither its queue nor the others.
 */
export function creerRepartiteurIa(ia: AccesIa, o: { simultanes?: number } = {}): RepartiteurIa {
  const simultanes = o.simultanes ?? IA_SIMULTANES;
  /** Pending calls, per run; a key with no pending call is no longer there. */
  const files = new Map<string, File>();
  /** The keys that wait, in the order they will be served: priority ones first. */
  const tours = { prioritaire: [] as string[], normal: [] as string[] };
  const tourDe = (f: File) => (f.prioritaire ? tours.prioritaire : tours.normal);
  let enVol = 0;

  const retirerCle = (cle: string, file: File) => {
    files.delete(cle);
    const tour = tourDe(file);
    const i = tour.indexOf(cle);
    if (i >= 0) tour.splice(i, 1);
  };

  const servir = () => {
    while (enVol < simultanes && (tours.prioritaire.length || tours.normal.length)) {
      const tour = tours.prioritaire.length ? tours.prioritaire : tours.normal;
      const cle = tour.shift()!;
      const file = files.get(cle)!;
      const appel = file.appels.shift()!;
      if (file.appels.length) tour.push(cle);
      else files.delete(cle);
      appel.detacher();
      enVol++;
      // `then` also catches an error thrown right away by the call.
      Promise.resolve()
        .then(() => {
          try {
            appel.auDemarrage?.();
          } catch (e) {
            console.error("[webaios] départ d'un appel à l'IA :", e);
          }
          return appel.lancer();
        })
        .then(appel.ok, appel.ko)
        .finally(() => {
          enVol--;
          servir();
        });
    }
  };

  const mettre = <T>(cle: string, prioritaire: boolean, lancer: () => Promise<T>, oa: OptionsAppelIa): Promise<T> =>
    new Promise<T>((ok, ko) => {
      const signal = oa.signal;
      if (signal?.aborted) return ko(new Error(IA_ABANDONNEE));
      let file = files.get(cle);
      if (!file) {
        file = { prioritaire, appels: [] };
        files.set(cle, file);
        tourDe(file).push(cle);
      }
      const appel: Appel = { lancer, ok: ok as (v: unknown) => void, ko, auDemarrage: oa.auDemarrage, detacher: () => {} };
      if (signal) {
        const abandon = () => {
          const f = files.get(cle);
          const i = f ? f.appels.indexOf(appel) : -1;
          if (f && i >= 0) {
            f.appels.splice(i, 1);
            if (!f.appels.length) retirerCle(cle, f);
          }
          ko(new Error(IA_ABANDONNEE));
        };
        signal.addEventListener("abort", abandon, { once: true });
        appel.detacher = () => signal.removeEventListener("abort", abandon);
      }
      file.appels.push(appel);
      servir();
    });

  return {
    pour: (cle, op = {}) => {
      const prioritaire = op.prioritaire ?? false;
      let oubliee = false;
      const appeler = <T>(lancer: () => Promise<T>, oa: OptionsAppelIa = {}): Promise<T> =>
        oubliee ? Promise.reject(new Error(IA_ABANDONNEE)) : mettre(cle, prioritaire, lancer, oa);
      return {
        kev: (corps, oa) => appeler(() => ia.kev(corps, oa?.signal ? { signal: oa.signal } : undefined), oa),
        gemma: (g, oa) => appeler(() => ia.gemma(oa?.signal ? { ...g, signal: g.signal ? AbortSignal.any([g.signal, oa.signal]) : oa.signal } : g), oa),
        oublier: () => {
          oubliee = true;
          const file = files.get(cle);
          if (!file) return;
          retirerCle(cle, file);
          for (const a of file.appels) {
            a.detacher();
            a.ko(new Error(IA_ABANDONNEE));
          }
        },
      };
    },
  };
}
