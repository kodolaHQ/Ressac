import type { IaLocale } from "./ia-locale.js";

/** Appels à l'IA locale en vol en même temps, toutes exécutions confondues. */
export const IA_SIMULTANES = 4;
/** Refus d'un appel d'une exécution terminée (abandonnée, tuée, arrêt du noyau) : il ne part plus vers l'IA. */
export const IA_ABANDONNEE = "Appel à l'IA abandonné : l'exécution est terminée";

type AccesIa = Pick<IaLocale, "kev" | "gemma">;
/** `auDemarrage` : appelé quand l'appel part vraiment vers l'IA. `signal` levé en file : refusé sans partir ; en vol : transmis. */
export type OptionsAppelIa = { auDemarrage?: () => void; signal?: AbortSignal };
/** La vue d'une exécution ; `oublier` (à sa fin) refuse ses appels encore en file et ceux qui viendraient après. */
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
  /** Détache l'écoute du signal (au départ de l'appel ou à son refus). */
  detacher: () => void;
};
type File = { prioritaire: boolean; appels: Appel[] };

/**
 * Sert les appels à l'IA locale à tour de rôle entre les exécutions : chaque `cle` (une exécution) a sa file, et quand
 * une place se libère, elle va à la file suivante qui attend. Une veille qui enchaîne les appels n'affame donc pas un
 * widget court. Les files prioritaires (les actions, lancées à la demande) qui attendent passent avant les autres, à tour
 * de rôle entre elles ; un appel en vol n'est jamais interrompu. `simultanes` appels au plus en vol ; une erreur ne
 * bloque ni sa file ni les autres.
 */
export function creerRepartiteurIa(ia: AccesIa, o: { simultanes?: number } = {}): RepartiteurIa {
  const simultanes = o.simultanes ?? IA_SIMULTANES;
  /** Appels en attente, par exécution ; une clé sans appel en attente n'y est plus. */
  const files = new Map<string, File>();
  /** Les clés qui attendent, dans l'ordre où elles seront servies : les prioritaires d'abord. */
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
      // `then` attrape aussi une erreur levée tout de suite par l'appel.
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
