/**
 * Video resume at the minute (tested alone): what the site actor (chrome/agent/site-actor.ts) does with the events of
 * each frame's `<video>`s. Nothing here imports the kernel: this file is bundled into the actor.
 */

/** A shorter video (ad, preview) is neither tracked nor resumed. */
export const MIN_RESUME_DURATION_S = 60;
/** During playback, a position noted at most every 10 s. */
export const POSITION_GAP_MS = 10_000;
/** Resume a little before the place left. */
export const RESUME_BACKOFF_S = 5;

export type VideoEvent = "loadedmetadata" | "play" | "timeupdate" | "pause" | "ended";
export const VIDEO_EVENTS: readonly VideoEvent[] = ["loadedmetadata", "play", "timeupdate", "pause", "ended"];

type State = { reglee: boolean; derniere: number | null };

export class ResumeTracking {
  /** Per element: is its resume settled (requested and returned), and when was its position noted. */
  private readonly etats = new WeakMap<object, State>();

  constructor(
    private readonly o: {
      /** `fin`: the video went to the end (`ended`). */
      noter(t: number, duration: number, end: boolean): void;
      /** The position kept for the page, if it belongs to a video of this duration (decided by the main process). */
      demander(duration: number): Promise<number | null>;
      maintenant(): number;
    },
  ) {}

  /**
   * An element's event (`cle`): the position to give to `currentTime`, or null. At the first event where the duration
   * is known and long enough, the page's position is requested with its duration, once per element; nothing is noted before
   * it is returned (a `timeupdate` at 0 s does not overwrite the kept position).
   */
  async surEvenement(type: VideoEvent, v: { currentTime: number; duration: number; cle: object }): Promise<number | null> {
    const { currentTime: t, duration: duration } = v;
    if (!Number.isFinite(duration) || duration < MIN_RESUME_DURATION_S || !Number.isFinite(t) || t < 0) return null;
    const state = this.etats.get(v.cle);
    if (!state) {
      const fresh: State = { reglee: false, derniere: null };
      this.etats.set(v.cle, fresh);
      let p: number | null = null;
      try {
        p = await this.o.demander(duration);
      } catch {
        p = null;
      }
      fresh.reglee = true;
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p >= duration) return null;
      return Math.max(0, p - RESUME_BACKOFF_S);
    }
    if (!state.reglee) return null;
    if (type === "pause" || type === "ended") this.noter(state, t, duration, type === "ended");
    else if (type === "timeupdate") {
      const now = this.o.maintenant();
      if (state.derniere === null || now - state.derniere >= POSITION_GAP_MS) this.noter(state, t, duration, false);
    }
    return null;
  }

  private noter(state: State, t: number, duration: number, end: boolean): void {
    state.derniere = this.o.maintenant();
    try {
      this.o.noter(t, duration, end);
    } catch {
      // a position is a convenience
    }
  }
}
