// Ménagement des sites : une recherche DuckDuckGo à la fois dans toute l'instance, une lecture à la fois par hôte,
// avec un écart minimal entre la fin d'une demande et le début de la suivante. Pur : horloge et attente injectables.

export const ECART_RECHERCHES_MS = 2000;
export const ECART_LECTURES_MS = 1000;

type Voie = { queue: Promise<unknown>; fin: number | null; en_cours: number };

const nouvelleVoie = (): Voie => ({ queue: Promise.resolve(), fin: null, en_cours: 0 });

/** Le site d'un hôte pour le ménagement : nom d'hôte en minuscules, sans « www. » ni point final (pas de liste des suffixes publics). */
export const siteMenage = (hote: string) => hote.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");

/**
 * Passe une lecture déjà commencée sur la voie d'un autre site (redirection) : la voie actuelle est rendue (sa
 * demande est partie), puis celle du nouveau site prise à son tour, après son écart. Sans effet pour le même site.
 * Rejetée si le signal de la lecture est levé pendant l'attente : la lecture ne tient alors plus aucune voie.
 */
export type ChangerHote = (hote: string) => Promise<void>;

/** Rend la voie prise : `partie` faux pour une demande qui n'est jamais partie (l'écart n'est pas consommé). */
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
   * `verifier` (facultatif) est appelé avant chaque attente et juste avant `f` : s'il lève, la recherche est rejetée
   * avec son erreur sans être partie, et l'écart de la voie n'est pas consommé (la suivante n'attend pas pour elle).
   */
  async rechercher<T>(f: () => Promise<T>, signal?: AbortSignal, verifier?: () => void): Promise<T> {
    const rendre = await this.prendre(this.recherches, ECART_RECHERCHES_MS, signal, verifier);
    return this.executer(() => f(), signal, () => rendre(true));
  }

  /**
   * Une lecture de `hote`, à son tour sur la voie de son site. `f` reçoit `changerHote` : à appeler avant de suivre
   * une redirection vers un autre site, pour respecter le ménagement de celui-ci.
   */
  async lire<T>(hote: string, f: (changerHote: ChangerHote) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let site = siteMenage(hote);
    let rendre: Rendre | null = await this.prendre(this.voieLecture(site), ECART_LECTURES_MS, signal);
    // Les changements de voie se suivent : jamais deux en même temps pour une même lecture.
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
        // La lecture a fini (abandonnée) pendant l'attente : la voie prise est rendue aussitôt.
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

  /** La voie de lecture d'un site, créée au besoin (les voies sans demande dont l'écart est écoulé sont retirées). */
  private voieLecture(site: string): Voie {
    this.nettoyer();
    let voie = this.lectures.get(site);
    if (!voie) this.lectures.set(site, (voie = nouvelleVoie()));
    return voie;
  }

  /** Retire les voies sans demande en cours dont l'écart est écoulé : plus rien à y ménager. */
  private nettoyer() {
    const t = this.maintenant();
    for (const [cle, v] of this.lectures) {
      if (v.en_cours === 0 && (v.fin === null || t - v.fin >= ECART_LECTURES_MS || t < v.fin)) this.lectures.delete(cle);
    }
  }

  /**
   * Lance `f` ; `liberer` est appelé à sa fin, quelle qu'elle soit. Avec un signal, la promesse rejette dès qu'il est
   * levé (la voie, elle, n'est rendue qu'à la vraie fin de `f`).
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
   * Prend la voie : attend la fin de la demande précédente puis l'écart. Rend de quoi la rendre. Une demande dont le
   * signal est levé en file rejette tout de suite ; quand son tour vient, elle passe sans rien consommer.
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
      // Attend que l'écart soit écoulé ; une horloge reculée n'allonge jamais l'attente au-delà de l'écart,
      // et un minuteur parti trop tôt est suivi d'une nouvelle vérification.
      for (;;) {
        if (signal?.aborted) throw interruption(signal);
        verifier?.();
        if (voie.fin === null) break;
        const t = this.maintenant();
        if (t < voie.fin) voie.fin = t; // horloge reculée : on repart de maintenant
        const reste = voie.fin + ecart - t;
        if (reste <= 0) break;
        await this.attendreOuInterrompre(reste, signal);
      }
    };
    const prise = voie.queue.then(tour);
    // La suivante attend que celle-ci rende la voie ; une demande qui n'a pas eu son tour la rend sans rien consommer.
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
          // Interrompue en file mais son tour venu quand même : elle n'en fait rien.
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
      // Une demande interrompue en file rejette tout de suite, sans attendre son tour.
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
