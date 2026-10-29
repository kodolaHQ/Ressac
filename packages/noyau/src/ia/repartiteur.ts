import type { IaLocale } from "./ia-locale.js";

/** Appels à l'IA locale en vol en même temps, toutes exécutions confondues. */
export const IA_SIMULTANES = 4;

type AccesIa = Pick<IaLocale, "kev" | "gemma">;
type Appel = { lancer: () => Promise<unknown>; ok: (v: unknown) => void; ko: (e: unknown) => void };

/**
 * Sert les appels à l'IA locale à tour de rôle entre les exécutions : chaque `cle` (une exécution) a sa file, et quand
 * une place se libère, elle va à la file suivante qui attend. Une veille qui enchaîne les appels n'affame donc pas un
 * widget court. `simultanes` appels au plus en vol ; une erreur ne bloque ni sa file ni les autres.
 */
export function creerRepartiteurIa(ia: AccesIa, o: { simultanes?: number } = {}): { pour(cle: string): AccesIa } {
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
    pour: (cle) => ({
      kev: (corps) => mettre(cle, () => ia.kev(corps)),
      gemma: (g) => mettre(cle, () => ia.gemma(g)),
    }),
  };
}
