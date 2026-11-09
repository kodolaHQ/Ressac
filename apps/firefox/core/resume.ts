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

type State = { set: boolean; last: number | null };

export class ResumeTracking {
  /** Per element: is its resume settled (requested and returned), and when was its position noted. */
  private readonly states = new WeakMap<object, State>();

  constructor(
    private readonly o: {
      /** `fin`: the video went to the end (`ended`). */
      note(t: number, duration: number, end: boolean): void;
      /** The position kept for the page, if it belongs to a video of this duration (decided by the main process). */
      ask(duration: number): Promise<number | null>;
      now(): number;
    },
  ) {}

  /**
   * An element's event (`cle`): the position to give to `currentTime`, or null. At the first event where the duration
   * is known and long enough, the page's position is requested with its duration, once per element; nothing is noted before
   * it is returned (a `timeupdate` at 0 s does not overwrite the kept position).
   */
  async onEvent(type: VideoEvent, v: { currentTime: number; duration: number; key: object }): Promise<number | null> {
    const { currentTime: t, duration } = v;
    if (!Number.isFinite(duration) || duration < MIN_RESUME_DURATION_S || !Number.isFinite(t) || t < 0) return null;
    const state = this.states.get(v.key);
    if (!state) {
      const fresh: State = { set: false, last: null };
      this.states.set(v.key, fresh);
      let p: number | null = null;
      try {
        p = await this.o.ask(duration);
      } catch {
        p = null;
      }
      fresh.set = true;
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p >= duration) return null;
      return Math.max(0, p - RESUME_BACKOFF_S);
    }
    if (!state.set) return null;
    if (type === "pause" || type === "ended") this.note(state, t, duration, type === "ended");
    else if (type === "timeupdate") {
      const now = this.o.now();
      if (state.last === null || now - state.last >= POSITION_GAP_MS) this.note(state, t, duration, false);
    }
    return null;
  }

  private note(state: State, t: number, duration: number, end: boolean): void {
    state.last = this.o.now();
    try {
      this.o.note(t, duration, end);
    } catch {
      // a position is a convenience
    }
  }
}
