// Pacing of the sites: one DuckDuckGo search at a time in the whole instance, one read at a time per host,
// with a minimal gap between the end of one request and the start of the next. Pure: clock and wait injectable.

export const SEARCHES_GAP_MS = 2000;
export const READS_GAP_MS = 1000;

type Route = { queue: Promise<unknown>; fin: number | null; en_cours: number };

const newRoute = (): Route => ({ queue: Promise.resolve(), fin: null, en_cours: 0 });

/** A host's site for the pacing: lowercase host name, without « www. » or trailing dot (no public suffix list). */
export const sitePacing = (host: string) => host.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");

/**
 * Moves a read already started onto another site's lane (redirect): the current lane is released (its
 * request has gone), then the new site's is taken in its turn, after its gap. No effect for the same site.
 * Rejected if the read's signal is raised during the wait: the read then holds no lane at all.
 */
export type ChangeHost = (host: string) => Promise<void>;

/** Releases the lane taken: `partie` false for a request that never went out (the gap is not consumed). */
type Render = (part: boolean) => void;

const interruption = (signal?: AbortSignal) => signal?.reason ?? new Error("Demande interrompue");

export class Pacing {
  private readonly maintenant: () => number;
  private readonly attendre: (ms: number) => Promise<void>;
  private readonly recherches: Route = newRoute();
  private readonly lectures = new Map<string, Route>();

  constructor(o: { maintenant?: () => number; attendre?: (ms: number) => Promise<void> } = {}) {
    this.maintenant = o.maintenant ?? Date.now;
    this.attendre = o.attendre ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /**
   * `verifier` (optional) is called before each wait and right before `f`: if it throws, the search is rejected
   * with its error without having gone out, and the lane's gap is not consumed (the next one does not wait for it).
   */
  async rechercher<T>(f: () => Promise<T>, signal?: AbortSignal, check?: () => void): Promise<T> {
    const render = await this.prendre(this.recherches, SEARCHES_GAP_MS, signal, check);
    return this.executer(() => f(), signal, () => render(true));
  }

  /**
   * A read of `hote`, in its turn on its site's lane. `f` receives `changerHote`: to call before following
   * a redirect to another site, to respect that one's pacing.
   */
  async lire<T>(host: string, f: (changeHost: ChangeHost) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let site = sitePacing(host);
    let render: Render | null = await this.prendre(this.voieLecture(site), READS_GAP_MS, signal);
    // Lane changes follow one another: never two at once for the same read.
    let changes: Promise<void> = Promise.resolve();
    let finished = false;
    const changeHost: ChangeHost = (other) => {
      const change = changes.then(async () => {
        const fresh = sitePacing(other);
        if (finished) throw new Error("Lecture déjà finie");
        if (fresh === site && render) return;
        render?.(true);
        render = null;
        site = fresh;
        render = await this.prendre(this.voieLecture(fresh), READS_GAP_MS, signal);
        // The read has finished (abandoned) during the wait: the lane taken is released right away.
        if (finished) {
          render(false);
          render = null;
        }
      });
      changes = change.catch(() => undefined);
      return change;
    };
    return this.executer(() => f(changeHost), signal, () => {
      finished = true;
      render?.(true);
      render = null;
    });
  }

  /** A site's read lane, created as needed (lanes without a request whose gap has elapsed are removed). */
  private voieLecture(site: string): Route {
    this.nettoyer();
    let route = this.lectures.get(site);
    if (!route) this.lectures.set(site, (route = newRoute()));
    return route;
  }

  /** Removes the lanes without a request in progress whose gap has elapsed: nothing left to pace there. */
  private nettoyer() {
    const t = this.maintenant();
    for (const [key, v] of this.lectures) {
      if (v.en_cours === 0 && (v.fin === null || t - v.fin >= READS_GAP_MS || t < v.fin)) this.lectures.delete(key);
    }
  }

  /**
   * Launches `f`; `liberer` is called at its end, whatever it is. With a signal, the promise rejects as soon as it is
   * raised (the lane, though, is only released at the real end of `f`).
   */
  private executer<T>(f: () => Promise<T>, signal: AbortSignal | undefined, release: () => void): Promise<T> {
    let execution: Promise<T>;
    try {
      execution = f();
    } catch (e) {
      execution = Promise.reject(e);
    }
    execution = execution.finally(release);
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
  private prendre(route: Route, gap: number, signal?: AbortSignal, check?: () => void): Promise<Render> {
    route.en_cours++;
    let open!: () => void;
    const rendered = new Promise<void>((r) => (open = r));
    let done = false;
    const render: Render = (part) => {
      if (done) return;
      done = true;
      if (part) route.fin = this.maintenant();
      route.en_cours--;
      open();
    };
    const turn = async (): Promise<void> => {
      // Waits until the gap has elapsed; a clock set back never lengthens the wait beyond the gap,
      // and a timer that fired too early is followed by a new check.
      for (;;) {
        if (signal?.aborted) throw interruption(signal);
        check?.();
        if (route.fin === null) break;
        const t = this.maintenant();
        if (t < route.fin) route.fin = t; // clock set back: we restart from now
        const rest = route.fin + gap - t;
        if (rest <= 0) break;
        await this.attendreOuInterrompre(rest, signal);
      }
    };
    const taken = route.queue.then(turn);
    // The next one waits for this one to release the lane; a request that has not had its turn releases it without consuming anything.
    route.queue = taken.then(
      () => rendered,
      () => render(false),
    );
    return new Promise<Render>((resolve, reject) => {
      let set = false;
      const stop = () => {
        if (set) return;
        set = true;
        reject(interruption(signal));
      };
      taken.then(
        () => {
          signal?.removeEventListener("abort", stop);
          // Interrupted in the queue but its turn came anyway: it does nothing with it.
          if (set) return render(false);
          set = true;
          resolve(render);
        },
        (e) => {
          signal?.removeEventListener("abort", stop);
          if (set) return;
          set = true;
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
