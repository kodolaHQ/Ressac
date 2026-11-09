// Pacing of the sites: one DuckDuckGo search at a time in the whole instance, one read at a time per host,
// with a minimal gap between the end of one request and the start of the next. Pure: clock and wait injectable.

export const ECART_RECHERCHES_MS = 2000;
export const ECART_LECTURES_MS = 1000;

type Voie = { queue: Promise<unknown>; fin: number | null; en_cours: number };

const nouvelleVoie = (): Voie => ({ queue: Promise.resolve(), fin: null, en_cours: 0 });

/** A host's site for the pacing: lowercase host name, without « www. » or trailing dot (no public suffix list). */
export const siteMenage = (hote: string) => hote.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");

/**
 * Moves a read already started onto another site's lane (redirect): the current lane is released (its
 * request has gone), then the new site's is taken in its turn, after its gap. No effect for the same site.
 * Rejected if the read's signal is raised during the wait: the read then holds no lane at all.
 */
export type ChangerHote = (hote: string) => Promise<void>;

/** Releases the lane taken: `partie` false for a request that never went out (the gap is not consumed). */
type Rendre = (partie: boolean) => void;

const interruption = (signal?: AbortSignal) => signal?.reason ?? new Error("Demande interrompue");

export class Menagement {
  private readonly maintenant: () => number;
  private readonly attendre: (ms: number) => Promise<void>;
  private readonly recherches: Voie = nouvelleVoie();
  private readonly lectures = new Map<string, Voie>();

  constructor(o: { maintenant?: () => number; attendre?: (ms: number) => Promise<void> } = {}) {
    this.maintenant = o.maintenant ?? Date.now;
    this.attendre = o.attendre ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /**
   * `verifier` (optional) is called before each wait and right before `f`: if it throws, the search is rejected
   * with its error without having gone out, and the lane's gap is not consumed (the next one does not wait for it).
   */
  async rechercher<T>(f: () => Promise<T>, signal?: AbortSignal, verifier?: () => void): Promise<T> {
    const rendre = await this.prendre(this.recherches, ECART_RECHERCHES_MS, signal, verifier);
    return this.executer(() => f(), signal, () => rendre(true));
  }

  /**
   * A read of `hote`, in its turn on its site's lane. `f` receives `changerHote`: to call before following
   * a redirect to another site, to respect that one's pacing.
   */
  async lire<T>(hote: string, f: (changerHote: ChangerHote) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let site = siteMenage(hote);
    let rendre: Rendre | null = await this.prendre(this.voieLecture(site), ECART_LECTURES_MS, signal);
    // Lane changes follow one another: never two at once for the same read.
    let changements: Promise<void> = Promise.resolve();
    let finie = false;
    const changerHote: ChangerHote = (autre) => {
      const changement = changements.then(async () => {
        const nouveau = siteMenage(autre);
        if (finie) throw new Error("Lecture déjà finie");
        if (nouveau === site && rendre) return;
        rendre?.(true);
        rendre = null;
        site = nouveau;
        rendre = await this.prendre(this.voieLecture(nouveau), ECART_LECTURES_MS, signal);
        // The read has finished (abandoned) during the wait: the lane taken is released right away.
        if (finie) {
          rendre(false);
          rendre = null;
        }
      });
      changements = changement.catch(() => undefined);
      return changement;
    };
    return this.executer(() => f(changerHote), signal, () => {
      finie = true;
      rendre?.(true);
      rendre = null;
    });
  }

  /** A site's read lane, created as needed (lanes without a request whose gap has elapsed are removed). */
  private voieLecture(site: string): Voie {
    this.nettoyer();
    let voie = this.lectures.get(site);
    if (!voie) this.lectures.set(site, (voie = nouvelleVoie()));
    return voie;
  }

  /** Removes the lanes without a request in progress whose gap has elapsed: nothing left to pace there. */
  private nettoyer() {
    const t = this.maintenant();
    for (const [cle, v] of this.lectures) {
      if (v.en_cours === 0 && (v.fin === null || t - v.fin >= ECART_LECTURES_MS || t < v.fin)) this.lectures.delete(cle);
    }
  }

  /**
   * Launches `f`; `liberer` is called at its end, whatever it is. With a signal, the promise rejects as soon as it is
   * raised (the lane, though, is only released at the real end of `f`).
   */
  private executer<T>(f: () => Promise<T>, signal: AbortSignal | undefined, liberer: () => void): Promise<T> {
    let execution: Promise<T>;
    try {
      execution = f();
    } catch (e) {
      execution = Promise.reject(e);
    }
    execution = execution.finally(liberer);
    if (!signal) return execution;
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(interruption(signal));
      execution.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
    });
  }

  /**
   * Takes the lane: waits for the end of the previous request then the gap. Returns what is needed to release it. A request whose
   * signal is raised in the queue rejects right away; when its turn comes, it passes without consuming anything.
   */
  private prendre(voie: Voie, ecart: number, signal?: AbortSignal, verifier?: () => void): Promise<Rendre> {
    voie.en_cours++;
    let ouvrir!: () => void;
    const rendue = new Promise<void>((r) => (ouvrir = r));
    let faite = false;
    const rendre: Rendre = (partie) => {
      if (faite) return;
      faite = true;
      if (partie) voie.fin = this.maintenant();
      voie.en_cours--;
      ouvrir();
    };
    const tour = async (): Promise<void> => {
      // Waits until the gap has elapsed; a clock set back never lengthens the wait beyond the gap,
      // and a timer that fired too early is followed by a new check.
      for (;;) {
        if (signal?.aborted) throw interruption(signal);
        verifier?.();
        if (voie.fin === null) break;
        const t = this.maintenant();
        if (t < voie.fin) voie.fin = t; // clock set back: we restart from now
        const reste = voie.fin + ecart - t;
        if (reste <= 0) break;
        await this.attendreOuInterrompre(reste, signal);
      }
    };
    const prise = voie.queue.then(tour);
    // The next one waits for this one to release the lane; a request that has not had its turn releases it without consuming anything.
    voie.queue = prise.then(
      () => rendue,
      () => rendre(false),
    );
    return new Promise<Rendre>((resolve, reject) => {
      let reglee = false;
      const stop = () => {
        if (reglee) return;
        reglee = true;
        reject(interruption(signal));
      };
      prise.then(
        () => {
          signal?.removeEventListener("abort", stop);
          // Interrupted in the queue but its turn came anyway: it does nothing with it.
          if (reglee) return rendre(false);
          reglee = true;
          resolve(rendre);
        },
        (e) => {
          signal?.removeEventListener("abort", stop);
          if (reglee) return;
          reglee = true;
          reject(e);
        },
      );
      if (!signal) return;
      // A request interrupted in the queue rejects right away, without waiting for its turn.
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
    });
  }

  private attendreOuInterrompre(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return this.attendre(ms);
    return new Promise<void>((resolve, reject) => {
      const stop = () => reject(interruption(signal));
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      this.attendre(ms).then(
        () => { signal.removeEventListener("abort", stop); resolve(); },
        (e) => { signal.removeEventListener("abort", stop); reject(e); },
      );
    });
  }
}
