// Ménagement des sites : une recherche DuckDuckGo à la fois dans toute l'instance, une lecture à la fois par hôte,
// avec un écart minimal entre la fin d'une demande et le début de la suivante. Pur : horloge et attente injectables.

export const ECART_RECHERCHES_MS = 2000;
export const ECART_LECTURES_MS = 1000;

type Voie = { queue: Promise<unknown>; fin: number | null; en_cours: number };

const nouvelleVoie = (): Voie => ({ queue: Promise.resolve(), fin: null, en_cours: 0 });
/** Clé d'une voie de lecture : nom d'hôte en minuscules, sans « www. » (pas de liste des suffixes publics). */
const cleHote = (hote: string) => hote.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");

export class Menagement {
  private readonly maintenant: () => number;
  private readonly attendre: (ms: number) => Promise<void>;
  private readonly recherches: Voie = nouvelleVoie();
  private readonly lectures = new Map<string, Voie>();

  constructor(o: { maintenant?: () => number; attendre?: (ms: number) => Promise<void> } = {}) {
    this.maintenant = o.maintenant ?? Date.now;
    this.attendre = o.attendre ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  rechercher<T>(f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.passer(this.recherches, ECART_RECHERCHES_MS, f, signal);
  }

  lire<T>(hote: string, f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.nettoyer();
    const cle = cleHote(hote);
    let voie = this.lectures.get(cle);
    if (!voie) this.lectures.set(cle, (voie = nouvelleVoie()));
    return this.passer(voie, ECART_LECTURES_MS, f, signal);
  }

  /** Retire les voies sans demande en cours dont l'écart est écoulé : plus rien à y ménager. */
  private nettoyer() {
    const t = this.maintenant();
    for (const [cle, v] of this.lectures) {
      if (v.en_cours === 0 && (v.fin === null || t - v.fin >= ECART_LECTURES_MS || t < v.fin)) this.lectures.delete(cle);
    }
  }

  private passer<T>(voie: Voie, ecart: number, f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const interrompu = () => signal?.reason ?? new Error("Demande interrompue");
    const tour = async (): Promise<T> => {
      // Attend que l'écart soit écoulé ; une horloge reculée n'allonge jamais l'attente au-delà de l'écart,
      // et un minuteur parti trop tôt est suivi d'une nouvelle vérification.
      for (;;) {
        if (signal?.aborted) throw interrompu();
        if (voie.fin === null) break;
        const t = this.maintenant();
        if (t < voie.fin) voie.fin = t; // horloge reculée : on repart de maintenant
        const reste = voie.fin + ecart - t;
        if (reste <= 0) break;
        await this.attendreOuInterrompre(reste, signal);
      }
      try {
        return await f();
      } finally {
        voie.fin = this.maintenant();
      }
    };
    voie.en_cours++;
    const execution = voie.queue.then(tour, tour);
    voie.queue = execution.catch(() => undefined).finally(() => { voie.en_cours--; });
    // Une demande interrompue en file rejette tout de suite, sans attendre son tour.
    if (!signal) return execution;
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(interrompu());
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      execution.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
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
