// Ménagement des sites : une recherche DuckDuckGo à la fois dans toute l'instance, une lecture à la fois par hôte,
// avec un écart minimal entre la fin d'une demande et le début de la suivante. Pur : horloge et attente injectables.

export const ECART_RECHERCHES_MS = 2000;
export const ECART_LECTURES_MS = 1000;

type Voie = { queue: Promise<unknown>; fin: number | null };

export class Menagement {
  private readonly maintenant: () => number;
  private readonly attendre: (ms: number) => Promise<void>;
  private readonly recherches: Voie = { queue: Promise.resolve(), fin: null };
  private readonly lectures = new Map<string, Voie>();

  constructor(o: { maintenant?: () => number; attendre?: (ms: number) => Promise<void> } = {}) {
    this.maintenant = o.maintenant ?? Date.now;
    this.attendre = o.attendre ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  rechercher<T>(f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.passer(this.recherches, ECART_RECHERCHES_MS, f, signal);
  }

  lire<T>(hote: string, f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const cle = hote.toLowerCase();
    let voie = this.lectures.get(cle);
    if (!voie) this.lectures.set(cle, (voie = { queue: Promise.resolve(), fin: null }));
    return this.passer(voie, ECART_LECTURES_MS, f, signal);
  }

  private passer<T>(voie: Voie, ecart: number, f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const interrompu = () => signal?.reason ?? new Error("Demande interrompue");
    const tour = async (): Promise<T> => {
      if (signal?.aborted) throw interrompu();
      if (voie.fin !== null) {
        const reste = voie.fin + ecart - this.maintenant();
        if (reste > 0) await this.attendreOuInterrompre(reste, signal);
      }
      if (signal?.aborted) throw interrompu();
      try {
        return await f();
      } finally {
        voie.fin = this.maintenant();
      }
    };
    const p = voie.queue.then(tour, tour);
    voie.queue = p.catch(() => undefined);
    return p;
  }

  private attendreOuInterrompre(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return this.attendre(ms);
    return new Promise<void>((resolve, reject) => {
      const stop = () => reject(signal.reason ?? new Error("Demande interrompue"));
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      this.attendre(ms).then(
        () => { signal.removeEventListener("abort", stop); resolve(); },
        (e) => { signal.removeEventListener("abort", stop); reject(e); },
      );
    });
  }
}
