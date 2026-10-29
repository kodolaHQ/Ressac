import { describe, expect, it } from "vitest";
import { ECART_LECTURES_MS, ECART_RECHERCHES_MS, Menagement, siteMenage } from "../../src/workflows/menagement.js";

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

  it("une demande en file dont le signal est levé rejette tout de suite, sans appeler f", async () => {
    let t = 0;
    const m = new Menagement({ maintenant: () => t, attendre: async (ms) => { t += ms; } });
    let finir!: () => void;
    const longue = m.lire("a.fr", () => new Promise<void>((r) => { finir = r; }));
    const ctrl = new AbortController();
    let appels = 0;
    const p = m.lire("a.fr", async () => { appels++; }, ctrl.signal);
    ctrl.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
    finir();
    await longue;
    await m.lire("a.fr", async () => {});
    expect(appels).toBe(0);
  });

  it("www.a.fr et a.fr partagent une voie, b.fr non", async () => {
    const { m, attentes } = factice();
    await m.lire("www.A.fr", async () => {});
    await m.lire("a.fr", async () => {});
    expect(attentes).toEqual([ECART_LECTURES_MS]);
    await m.lire("b.fr", async () => {});
    expect(attentes).toEqual([ECART_LECTURES_MS]);
  });

  it("une horloge reculée n'allonge pas l'attente au-delà de l'écart", async () => {
    const { m, attentes, avancer } = factice();
    await m.rechercher(async () => {});
    avancer(-3_600_000);
    await m.rechercher(async () => {});
    expect(attentes).toEqual([ECART_RECHERCHES_MS]);
  });

  it("un minuteur parti trop tôt est suivi d'une nouvelle attente", async () => {
    let t = 0;
    const attentes: number[] = [];
    const m = new Menagement({ maintenant: () => t, attendre: async (ms) => { attentes.push(ms); t += attentes.length === 1 ? ms - 1 : ms; } });
    await m.rechercher(async () => {});
    await m.rechercher(async () => {});
    expect(attentes).toEqual([2000, 1]);
  });

  it("une recherche refusée avant son tour (verifier lève) n'appelle pas f et ne consomme pas l'écart", async () => {
    const { m, attentes } = factice();
    await m.rechercher(async () => 1);
    let appels = 0;
    const refus = () => { throw new Error("refusée"); };
    await expect(m.rechercher(async () => { appels++; }, undefined, refus)).rejects.toThrow("refusée");
    expect(appels).toBe(0);
    expect(attentes).toEqual([]);
    await m.rechercher(async () => 3);
    expect(attentes).toEqual([ECART_RECHERCHES_MS]);
  });

  it("une recherche refusée pendant son attente ne retarde pas la suivante", async () => {
    let t = 1000;
    let refusee = false;
    const attentes: number[] = [];
    const m = new Menagement({ maintenant: () => t, attendre: async (ms) => { attentes.push(ms); t += ms; refusee = true; } });
    await m.rechercher(async () => 1);
    const verifier = () => { if (refusee) throw new Error("refusée"); };
    await expect(m.rechercher(async () => 2, undefined, verifier)).rejects.toThrow("refusée");
    // L'écart compte toujours depuis la fin de la première : la suivante n'attend plus rien.
    await m.rechercher(async () => 3);
    expect(attentes).toEqual([ECART_RECHERCHES_MS]);
  });

  it("siteMenage : minuscules, sans www. ni point final", () => {
    expect(siteMenage("WWW.Exemple.fr.")).toBe("exemple.fr");
    expect(siteMenage("blog.exemple.fr")).toBe("blog.exemple.fr");
  });

  it("une lecture redirigée vers un autre hôte attend l'écart de cet hôte, et rend la voie du premier", async () => {
    const { m, attentes, maintenant } = factice();
    await m.lire("b.fr", async () => {});
    let lueA = -1;
    await m.lire("a.fr", async (changerHote) => {
      await changerHote("b.fr");
      lueA = maintenant();
    });
    expect(attentes).toEqual([ECART_LECTURES_MS]);
    expect(lueA).toBe(1000 + ECART_LECTURES_MS);
    // a.fr rendue à la redirection (t = 1000) : écart écoulé. b.fr, finie à 2000 : 1 s.
    await m.lire("a.fr", async () => {});
    expect(attentes).toEqual([ECART_LECTURES_MS]);
    await m.lire("b.fr", async () => {});
    expect(attentes).toEqual([ECART_LECTURES_MS, ECART_LECTURES_MS]);
  });

  it("redirection vers le même site (www., majuscules) : rien ne change", async () => {
    const { m, attentes } = factice();
    await m.lire("a.fr", async (changerHote) => {
      await changerHote("WWW.a.fr");
      await changerHote("a.fr");
    });
    expect(attentes).toEqual([]);
  });

  it("pendant une lecture redirigée vers b.fr, une lecture de b.fr attend sa fin ; une lecture de a.fr passe", async () => {
    let t = 0;
    const m = new Menagement({ maintenant: () => t, attendre: async (ms) => { t += ms; } });
    let finir!: () => void;
    let redirigee!: () => void;
    const estRedirigee = new Promise<void>((r) => (redirigee = r));
    const longue = m.lire("a.fr", async (changerHote) => {
      await changerHote("b.fr");
      redirigee();
      await new Promise<void>((r) => (finir = r));
    });
    await estRedirigee;
    const journal: string[] = [];
    const b = m.lire("b.fr", async () => void journal.push(`b@${t}`));
    const a = m.lire("a.fr", async () => void journal.push(`a@${t}`));
    await a;
    expect(journal).toEqual([`a@${ECART_LECTURES_MS}`]);
    t = 5000;
    finir();
    await longue;
    await b;
    expect(journal).toEqual([`a@${ECART_LECTURES_MS}`, `b@${5000 + ECART_LECTURES_MS}`]);
  });

  it("a.fr → b.fr → a.fr : chaque voie reprise à son tour, sans blocage", async () => {
    const { m, attentes } = factice();
    await m.lire("a.fr", async (changerHote) => {
      await changerHote("b.fr");
      await changerHote("a.fr");
    });
    // Retour sur a.fr, rendue à la première redirection : 1 s d'écart.
    expect(attentes).toEqual([ECART_LECTURES_MS]);
  });

  it("signal levé pendant l'attente d'une redirection : rejetée, aucune voie ne reste prise", async () => {
    let t = 0;
    const enAttente: (() => void)[] = [];
    const m = new Menagement({ maintenant: () => t, attendre: () => new Promise<void>((ok) => enAttente.push(ok)) });
    await m.lire("b.fr", async () => {});
    const ctrl = new AbortController();
    const p = m.lire("a.fr", async (changerHote) => { await changerHote("b.fr"); return "lue"; }, ctrl.signal);
    await new Promise((r) => setTimeout(r, 0));
    ctrl.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
    t = 10_000;
    for (const ok of enAttente.splice(0)) ok();
    // Ni a.fr ni b.fr ne restent prises.
    await m.lire("a.fr", async () => {});
    await m.lire("b.fr", async () => {});
    expect(enAttente).toEqual([]);
  });
});
