/** Delay between the real press in a widget and the link request it allows (long press included). */
export const DELAI_GESTE_MS = 1500;

/**
 * A widget opens a link only right after a real click in its display. The click is seen in the widget's frame by
 * the actor (chrome world, `isTrusted`), which the widget's code can neither read nor imitate, then reported to the
 * parent process. Only the last gesture of each window counts; it allows a single link, to the only widget where it happened.
 */
export function gardienGestes<F>(maintenant: () => number = () => Date.now()) {
  const derniers = new Map<F, { t: number; widget: string }>();
  return {
    /** Real mouse press in the display of widget `widget` of this window. */
    geste(fenetre: F, widget: string) {
      derniers.set(fenetre, { t: maintenant(), widget });
    },
    /** Link request from widget `widget`: accepted (and the gesture consumed) if its last gesture is recent and its own. */
    accepter(fenetre: F, widget: string): boolean {
      const g = derniers.get(fenetre);
      if (!g || g.widget !== widget || maintenant() - g.t > DELAI_GESTE_MS) return false;
      derniers.delete(fenetre);
      return true;
    },
  };
}
