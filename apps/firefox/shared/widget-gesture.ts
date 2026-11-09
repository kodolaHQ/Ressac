/** Delay between the real press in a widget and the link request it allows (long press included). */
export const GESTURE_DELAY_MS = 1500;

/**
 * A widget opens a link only right after a real click in its display. The click is seen in the widget's frame by
 * the actor (chrome world, `isTrusted`), which the widget's code can neither read nor imitate, then reported to the
 * parent process. Only the last gesture of each window counts; it allows a single link, to the only widget where it happened.
 */
export function gestureGuard<F>(now: () => number = () => Date.now()) {
  const last = new Map<F, { t: number; widget: string }>();
  return {
    /** Real mouse press in the display of widget `widget` of this window. */
    geste(win: F, widget: string) {
      last.set(win, { t: now(), widget });
    },
    /** Link request from widget `widget`: accepted (and the gesture consumed) if its last gesture is recent and its own. */
    accepter(win: F, widget: string): boolean {
      const g = last.get(win);
      if (!g || g.widget !== widget || now() - g.t > GESTURE_DELAY_MS) return false;
      last.delete(win);
      return true;
    },
  };
}
