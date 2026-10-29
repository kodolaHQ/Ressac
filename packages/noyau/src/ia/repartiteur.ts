import type { IaLocale } from "./ia-locale.js";

/** Appels à l'IA locale en vol en même temps, toutes exécutions confondues. */
export const IA_SIMULTANES = 4;
/** Refus d'un appel d'une exécution terminée (abandonnée, tuée, arrêt du noyau) : il ne part plus vers l'IA. */
export const IA_ABANDONNEE = "Appel à l'IA abandonné : l'exécution est terminée";

type AccesIa = Pick<IaLocale, "kev" | "gemma">;
/** La vue d'une exécution ; `oublier` (à sa fin) refuse ses appels encore en file et ceux qui viendraient après. */
export type AccesIaExecution = AccesIa & { oublier(): void };
type Appel = { lancer: () => Promise<unknown>; ok: (v: unknown) => void; ko: (e: unknown) => void };

/**
 * Sert les appels à l'IA locale à tour de rôle entre les exécutions : chaque `cle` (une exécution) a sa file, et quand
 * une place se libère, elle va à la file suivante qui attend. Une veille qui enchaîne les appels n'affame donc pas un
 * widget court. `simultanes` appels au plus en vol ; une erreur ne bloque ni sa file ni les autres.
 */
export function creerRepartiteurIa(ia: AccesIa, o: { simultanes?: number } = {}): { pour(cle: string): AccesIaExecution } {
  const simultanes = o.simultanes ?? IA_SIMULTANES;
  /** Appels en attente, par exécution ; une clé sans appel en attente n'y est plus. */
  const files = new Map<string, Appel[]>();
  /** Les clés qui attendent, dans l'ordre où elles seront servies. */
  const tour: string[] = [];
  let enVol = 0;

  const servir = () => {
    while (enVol < simultanes && tour.length) {
      const cle = tour.shift()!;
      const file = files.get(cle)!;
      const appel = file.shift()!;
      if (file.length) tour.push(cle);
      else files.delete(cle);
      enVol++;
      // `then` attrape aussi une erreur levée tout de suite par l'appel.
      Promise.resolve()
        .then(appel.lancer)
        .then(appel.ok, appel.ko)
        .finally(() => {
          enVol--;
          servir();
        });
    }
  };

  const mettre = <T>(cle: string, lancer: () => Promise<T>): Promise<T> =>
    new Promise<T>((ok, ko) => {
      let file = files.get(cle);
      if (!file) {
        file = [];
        files.set(cle, file);
        tour.push(cle);
      }
      file.push({ lancer, ok: ok as (v: unknown) => void, ko });
      servir();
    });

  return {
    pour: (cle) => {
      let oubliee = false;
      const appeler = <T>(lancer: () => Promise<T>): Promise<T> => (oubliee ? Promise.reject(new Error(IA_ABANDONNEE)) : mettre(cle, lancer));
      return {
        kev: (corps) => appeler(() => ia.kev(corps)),
        gemma: (g) => appeler(() => ia.gemma(g)),
        oublier: () => {
          oubliee = true;
          const file = files.get(cle);
          if (!file) return;
          files.delete(cle);
          tour.splice(tour.indexOf(cle), 1);
          for (const a of file) a.ko(new Error(IA_ABANDONNEE));
        },
      };
    },
  };
}
