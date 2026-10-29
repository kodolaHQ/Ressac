import { expect, test } from "vitest";
import { creerRepartiteurIa, IA_ABANDONNEE, IA_SIMULTANES } from "../../src/ia/repartiteur.js";

/** Une IA factice : chaque appel attend qu'on le termine de l'extérieur. */
function iaFactice() {
  const journal: string[] = [];
  const enCours: { nom: string; finir: (v?: unknown) => void; echouer: (e: Error) => void }[] = [];
  let enVol = 0;
  let max = 0;
  const appel = (nom: string) =>
    new Promise<unknown>((ok, ko) => {
      journal.push(nom);
      max = Math.max(max, ++enVol);
      const fin = (f: () => void) => () => {
        enVol--;
        f();
      };
      enCours.push({ nom, finir: (v) => fin(() => ok(v ?? nom))(), echouer: (e) => fin(() => ko(e))() });
    });
  return {
    journal,
    enCours,
    max: () => max,
    ia: {
      kev: (corps: { state: unknown; questions: Record<string, unknown> }) => appel(`kev ${String(corps.state)}`),
      gemma: (o: { prompt: string }) => appel(`gemma ${o.prompt}`),
    },
    /** Termine le plus ancien appel en vol. */
    finirPremier: async (erreur?: Error) => {
      const a = enCours.shift()!;
      if (erreur) a.echouer(erreur);
      else a.finir();
      await new Promise((r) => setImmediate(r));
    },
  };
}

const attendre = () => new Promise((r) => setImmediate(r));

test("IA_SIMULTANES vaut 4", () => {
  expect(IA_SIMULTANES).toBe(4);
});

test("deux exécutions : l'appel de la courte passe entre deux appels de la longue", async () => {
  const f = iaFactice();
  const r = creerRepartiteurIa(f.ia, { simultanes: 1 });
  const longue = r.pour("veille:2026-10-29T10:00:00.000Z");
  const courte = r.pour("meteo:2026-10-29T10:01:00.000Z");
  const appels = [longue.gemma({ prompt: "L1" }), longue.gemma({ prompt: "L2" }), longue.gemma({ prompt: "L3" })];
  await attendre();
  appels.push(courte.gemma({ prompt: "C1" }));
  await attendre();
  expect(f.journal).toEqual(["gemma L1"]);
  for (let i = 0; i < 4; i++) await f.finirPremier();
  expect(f.journal).toEqual(["gemma L1", "gemma L2", "gemma C1", "gemma L3"]);
  expect(await Promise.all(appels)).toEqual(["gemma L1", "gemma L2", "gemma L3", "gemma C1"]);
});

test("jamais plus de 4 appels en vol", async () => {
  const f = iaFactice();
  const r = creerRepartiteurIa(f.ia);
  const appels: Promise<unknown>[] = [];
  for (const cle of ["a", "b", "c"]) for (let i = 0; i < 4; i++) appels.push(r.pour(cle).kev({ state: `${cle}${i}`, questions: {} }));
  await attendre();
  expect(f.enCours).toHaveLength(4);
  while (f.enCours.length) await f.finirPremier();
  await Promise.all(appels);
  expect(f.journal).toHaveLength(12);
  expect(f.max()).toBe(4);
  // Les quatre de « a » partent tout de suite ; ensuite « b » et « c » sont servis à tour de rôle.
  expect(f.journal.slice(4, 8)).toEqual(["kev b0", "kev c0", "kev b1", "kev c1"]);
});

test("un appel en erreur n'arrête pas sa file", async () => {
  const f = iaFactice();
  const r = creerRepartiteurIa(f.ia, { simultanes: 1 });
  const ia = r.pour("x");
  const premier = ia.gemma({ prompt: "1" });
  const second = ia.gemma({ prompt: "2" });
  await attendre();
  const refus = expect(premier).rejects.toThrow("Gemma indisponible");
  await f.finirPremier(new Error("Gemma indisponible"));
  await refus;
  await f.finirPremier();
  expect(await second).toBe("gemma 2");
});

test("un appel qui lève tout de suite n'arrête pas sa file", async () => {
  let n = 0;
  const r = creerRepartiteurIa(
    {
      kev: () => {
        n++;
        if (n === 1) throw new Error("tout de suite");
        return Promise.resolve("ok");
      },
      gemma: async () => "g",
    },
    { simultanes: 1 },
  );
  const ia = r.pour("x");
  await expect(ia.kev({ state: 1, questions: {} })).rejects.toThrow("tout de suite");
  expect(await ia.kev({ state: 2, questions: {} })).toBe("ok");
});

test("oublier : les appels en file de l'exécution sont refusés sans partir, comme ceux qui viennent après", async () => {
  const f = iaFactice();
  const r = creerRepartiteurIa(f.ia, { simultanes: 1 });
  const a = r.pour("a");
  const b = r.pour("b");
  const a1 = a.gemma({ prompt: "a1" });
  const a2 = a.gemma({ prompt: "a2" });
  const b1 = b.gemma({ prompt: "b1" });
  await attendre();
  const refus = expect(a2).rejects.toThrow(IA_ABANDONNEE);
  a.oublier();
  await refus;
  await expect(a.gemma({ prompt: "a3" })).rejects.toThrow(IA_ABANDONNEE);
  // L'appel déjà en vol finit normalement ; la place va ensuite à « b ».
  await f.finirPremier();
  expect(await a1).toBe("gemma a1");
  await f.finirPremier();
  expect(await b1).toBe("gemma b1");
  expect(f.journal).toEqual(["gemma a1", "gemma b1"]);
});
