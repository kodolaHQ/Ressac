import { REVEAL_EDGE, BAR_WIDTH, BAR_MARGIN, LEFT_EXIT } from "./model";

/**
 * Compact mode: where the mouse is relative to the window's left edge. « bord » reveals the bar, « barre »
 * keeps it open (the bar and a margin to its right), « loin » closes it again.
 */
export type LeftZone = "bord" | "barre" | "loin";

/** Mouse zone at `x` px from the window's left edge. */
export function leftZone(x: number): LeftZone {
  if (x < REVEAL_EDGE) return "bord";
  return x < BAR_WIDTH + BAR_MARGIN ? "barre" : "loin";
}

/** Zone of a mouse leaving a surface (page, UI) after last being seen at `x`: a fast gesture to the left counts as the edge. */
export function exitZone(x: number): LeftZone {
  return x < LEFT_EXIT ? "bord" : leftZone(x);
}

export interface Reveal {
  revelee: boolean;
  /** The mouse left the edge since the last hiding: returning to it reveals the bar again. */
  armee: boolean;
}

export const INITIAL_REVEAL: Reveal = { revelee: false, armee: true };

/**
 * The mouse moves into `zone`. Hysteresis: the bar is revealed at the edge, stays open over itself and its margin, and only
 * closes (`masquer`, after a short delay) beyond that; a mouse left at the edge after a hiding must leave it
 * before revealing it again. So the page shifting under a still mouse does not make the bar blink.
 */
export function onZone(r: Reveal, zone: LeftZone): Reveal & { masquer: boolean } {
  const armed = r.armee || zone !== "bord";
  if (r.revelee) return { revelee: true, armee: armed, masquer: zone === "loin" };
  return { revelee: zone === "bord" && armed, armee: armed, masquer: false };
}

/** The bar hides while the mouse is in `zone`. */
export function hide(zone: LeftZone): Reveal {
  return { revelee: false, armee: zone !== "bord" };
}
