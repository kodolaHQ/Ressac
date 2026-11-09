/**
 * Video resume at the minute (tested alone): what the site actor (chrome/agent/site-actor.ts) does with the events of
 * each frame's `<video>`s. Nothing here imports the kernel: this file is bundled into the actor.
 */

/** A shorter video (ad, preview) is neither tracked nor resumed. */
export const DUREE_MIN_REPRISE_S = 60;
/** During playback, a position noted at most every 10 s. */
export const ECART_POSITION_MS = 10_000;
/** Resume a little before the place left. */
export const RECUL_REPRISE_S = 5;

export type EvenementVideo = "loadedmetadata" | "play" | "timeupdate" | "pause" | "ended";
export const EVENEMENTS_VIDEO: readonly EvenementVideo[] = ["loadedmetadata", "play", "timeupdate", "pause", "ended"];

type Etat = { reglee: boolean; derniere: number | null };

export class SuiviReprise {
  /** Per element: is its resume settled (requested and returned), and when was its position noted. */
  private readonly etats = new WeakMap<object, Etat>();

  constructor(
    private readonly o: {
      /** `fin`: the video went to the end (`ended`). */
      noter(t: number, duree: number, fin: boolean): void;
      /** The position kept for the page, if it belongs to a video of this duration (decided by the main process). */
      demander(duree: number): Promise<number | null>;
      maintenant(): number;
    },
  ) {}

  /**
   * An element's event (`cle`): the position to give to `currentTime`, or null. At the first event where the duration
   * is known and long enough, the page's position is requested with its duration, once per element; nothing is noted before
   * it is returned (a `timeupdate` at 0 s does not overwrite the kept position).
   */
  async surEvenement(type: EvenementVideo, v: { currentTime: number; duration: number; cle: object }): Promise<number | null> {
    const { currentTime: t, duration: duree } = v;
    if (!Number.isFinite(duree) || duree < DUREE_MIN_REPRISE_S || !Number.isFinite(t) || t < 0) return null;
    const etat = this.etats.get(v.cle);
    if (!etat) {
      const nouveau: Etat = { reglee: false, derniere: null };
      this.etats.set(v.cle, nouveau);
      let p: number | null = null;
      try {
        p = await this.o.demander(duree);
      } catch {
        p = null;
      }
      nouveau.reglee = true;
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p >= duree) return null;
      return Math.max(0, p - RECUL_REPRISE_S);
    }
    if (!etat.reglee) return null;
    if (type === "pause" || type === "ended") this.noter(etat, t, duree, type === "ended");
    else if (type === "timeupdate") {
      const maintenant = this.o.maintenant();
      if (etat.derniere === null || maintenant - etat.derniere >= ECART_POSITION_MS) this.noter(etat, t, duree, false);
    }
    return null;
  }

  private noter(etat: Etat, t: number, duree: number, fin: boolean): void {
    etat.derniere = this.o.maintenant();
    try {
      this.o.noter(t, duree, fin);
    } catch {
      // a position is a convenience
    }
  }
}
