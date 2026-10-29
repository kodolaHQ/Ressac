import { describe, expect, it } from "vitest";
import { ECART_LECTURES_MS, ECART_RECHERCHES_MS, Menagement } from "../../src/workflows/menagement.js";

/** Horloge et attente factices : attendre(ms) fait avancer le temps sans dormir. */
function factice() {
  let t = 1000;
  const attentes: number[] = [];
  const m = new Menagement({
    maintenant: () => t,
    attendre: async (ms) => { attentes.push(ms); t += ms; },
  });
  return { m, attentes, maintenant: () => t, avancer: (ms: number) => { t += ms; } };
}

describe("Menagement", () => {
  it("deux recherches : la seconde commence 2 s après la fin de la première", async () => {
    const { m, maintenant, avancer } = factice();
    const debuts: number[] = [];
    const fins: number[] = [];
    const f = async () => { debuts.push(maintenant()); avancer(300); fins.push(maintenant()); };
    await Promise.all([m.rechercher(f), m.rechercher(f)]);
    expect(debuts[1]! - fins[0]!).toBe(ECART_RECHERCHES_MS);
    expect(ECART_RECHERCHES_MS).toBe(2000);
  });

  it("deux lectures du même hôte espacées d'1 s, deux hôtes en même temps", async () => {
    const { m, maintenant, avancer } = factice();
    const journal: string[] = [];
    const lecture = (nom: string) => async () => { journal.push(`${nom}@${maintenant()}`); avancer(0); };
    await Promise.all([
      m.lire("a.fr", lecture("a1")),
      m.lire("a.fr", lecture("a2")),
      m.lire("b.fr", lecture("b1")),
    ]);
    const t = (n: string) => Number(journal.find((j) => j.startsWith(n + "@"))!.split("@")[1]);
    expect(t("a2") - t("a1")).toBe(ECART_LECTURES_MS);
    expect(t("b1")).toBe(t("a1"));
    expect(ECART_LECTURES_MS).toBe(1000);
  });

  it("une recherche dont le signal est levé en attente n'appelle pas f", async () => {
    let liberer!: () => void;
    const m = new Menagement({ maintenant: () => 0, attendre: () => new Promise<void>((r) => { liberer = r; }) });
    await m.rechercher(async () => 1);
    const ctrl = new AbortController();
    let appels = 0;
    const p = m.rechercher(async () => { appels++; }, ctrl.signal);
    await Promise.resolve();
    ctrl.abort();
    await expect(p).rejects.toThrow();
    liberer?.();
    expect(appels).toBe(0);
  });

  it("une recherche annulée avant son tour ne retarde pas la suivante", async () => {
    const { m, attentes } = factice();
    await m.rechercher(async () => 1);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(m.rechercher(async () => 2, ctrl.signal)).rejects.toThrow();
    attentes.length = 0;
    await m.rechercher(async () => 3);
    expect(attentes).toEqual([ECART_RECHERCHES_MS]);
  });

  it("une erreur de f laisse passer la suivante", async () => {
    const { m } = factice();
    const a = m.rechercher(async () => { throw new Error("boum"); });
    const b = m.rechercher(async () => "ok");
    await expect(a).rejects.toThrow("boum");
    await expect(b).resolves.toBe("ok");
  });

  it("deux instances ne partagent rien", async () => {
    const un = factice();
    const deux = factice();
    await un.m.rechercher(async () => 1);
    await deux.m.rechercher(async () => 1);
    expect(deux.attentes).toEqual([]);
  });
});
