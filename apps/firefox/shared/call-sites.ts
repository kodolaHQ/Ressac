/** A key a call site listens for, as its own keyboard shortcut. */
export interface CallKey {
  key: string;
  code: string;
  keyCode: number;
  meta?: boolean;
  shift?: boolean;
}

/** A site whose calls get the mini player's microphone and camera buttons. */
export interface CallSite {
  /** A regular expression on the page's host name. */
  host: string;
  mic: CallKey;
  camera: CallKey;
  /** The site's own microphone then camera buttons, each with `data-is-muted`: the state the site shows. */
  buttons?: string;
}

const D: CallKey = { key: "d", code: "KeyD", keyCode: 68, meta: true };
const E: CallKey = { key: "e", code: "KeyE", keyCode: 69, meta: true };
const shifted = (letter: string): CallKey => ({ key: letter, code: `Key${letter}`, keyCode: letter.charCodeAt(0), meta: true, shift: true });

/** The sites' own macOS shortcuts (their help pages, 2026-11). More can be added without a build: pref `webaios.call.sites` (a JSON array). */
export const CALL_SITES: CallSite[] = [
  { host: "^meet\\.google\\.com$", mic: D, camera: E, buttons: "button[data-is-muted]" },
  { host: "(^|\\.)teams\\.(microsoft\\.com|live\\.com|cloud\\.microsoft)$", mic: shifted("M"), camera: shifted("O") },
  { host: "(^|\\.)zoom\\.us$", mic: shifted("A"), camera: shifted("V") },
];

/** A background tab in a call: whether its microphone and its camera send. */
export interface CallState {
  mic: boolean;
  camera: boolean;
}
