import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AgentPanelState } from "../../shared/api";
import { api } from "../state.svelte";
import { labelsOn, withoutPasteMarkers } from "./terminalLabels";

/**
 * The window's agent terminal: **a single** xterm, subscribed only once to the session's data. The side panel and
 * the builder's « Agent » tab display it in turn by moving its element from one host to the other: two terminals
 * would receive the output twice and answer twice.
 */

/** What the window's agent shows (preparing, active, error…), the same for all hosts. */
export const agent = $state<{ state: AgentPanelState; busy: boolean }>({ state: { state: "preparing" }, busy: false });

/**
 * Ressac's bubble beside the terminal, in the host showing it (MaskBubble): a label's value revealed here only, or a
 * paste held until the user chooses. Never written to the session; dropped as soon as it hides.
 */
export type Bubble =
  | { kind: "reveal"; host: HTMLElement; value: string | null }
  | { kind: "paste"; host: HTMLElement; names: string[] | null; masked: string | null; original: string };
export const bubble = $state<{ current: Bubble | null }>({ current: null });
/** Each click supersedes the previous one still waiting on the host; a dismissal drops it too. */
let asked = 0;
/**
 * Each paste supersedes the previous one; a dismissal (a new session, the terminal moving) does not: a paste waiting on
 * the host is kept until its answer, then written or shown in the bubble where the terminal is then.
 */
let pastes = 0;
/** True while `terminal.paste` runs: xterm sends a paste through `onData` synchronously, like a keystroke. */
let pasting = false;
function paste(text: string): void {
  pasting = true;
  try {
    terminal?.paste(withoutPasteMarkers(text));
  } finally {
    pasting = false;
  }
}
export function dismissBubble(): void {
  asked++;
  bubble.current = null;
}

/** A label clicked in the terminal: its value, from this window's own conversation, in the bubble; the agent learns nothing. */
async function reveal(label: string): Promise<void> {
  const n = ++asked;
  const value = await api.agent.revealLocal(label);
  const host = hosts.at(-1);
  if (n === asked && host) bubble.current = { kind: "reveal", host, value };
}

/** A paste or a drop, held: written at once when it hides nothing, else only on the user's choice in the bubble. */
async function holdPaste(original: string): Promise<void> {
  const n = ++pastes;
  const r = await api.agent.maskPaste(original);
  const host = hosts.at(-1);
  if (n !== pastes || !terminal || !host) return;
  // A reveal still waiting must not cover the paste's bubble.
  asked++;
  if (r && !r.names.length) return paste(original);
  // The host could not check it (r null): nothing goes until « Coller en clair ».
  bubble.current = { kind: "paste", host, names: r?.names ?? null, masked: r?.text ?? null, original };
}

/** The bubble's answer: the masked text or the original goes to the agent as a paste. */
export function choosePaste(masked: boolean): void {
  const b = bubble.current;
  dismissBubble();
  if (b?.kind !== "paste") return;
  const text = masked ? b.masked : b.original;
  if (text !== null) paste(text);
}

/** The agent counts as answering while its output flows; this long a silence ends the answer. */
const BUSY_QUIET_MS = 900;
let quiet: ReturnType<typeof setTimeout> | undefined;
function flowing(): void {
  agent.busy = true;
  clearTimeout(quiet);
  quiet = setTimeout(() => (agent.busy = false), BUSY_QUIET_MS);
}

export const MONO_FALLBACK = "ui-monospace, Menlo, monospace";
/** xterm paints with JS colours: read from the tokens, again when the theme or the space's aura changes. */
export function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const accent = v("--accent");
  return {
    background: v("--sheet"),
    foreground: v("--text"),
    cursor: accent,
    cursorAccent: v("--sheet"),
    // The accents are #rrggbb tokens: 59 is 35 % alpha (xterm does not parse color-mix).
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}59` : accent,
  };
}

let terminal: Terminal | undefined;
let adjustment: FitAddon | undefined;
/** Where xterm opened: this element moves from one host to another, xterm stays inside. */
let element: HTMLDivElement | undefined;
/** Attached hosts, the last one shows the terminal; detaching one gives the terminal back to the previous one. */
const hosts: HTMLElement[] = [];

// A restarting session (Relancer, profile change) clears the previous one's screen.
const endState = api.agent.onState((e) => {
  if (e.state === "preparing" && agent.state.state !== "preparing") {
    terminal?.reset();
    // Another conversation: its labels are not this one's.
    dismissBubble();
  }
  agent.state = e;
});
let dataEnd: (() => void) | undefined;

const size = () => ({ cols: Math.max(2, terminal?.cols ?? 80), rows: Math.max(2, terminal?.rows ?? 24) });

/** The terminal is born at the first shown host (a size is needed to measure it); the window's session starts with it. */
function create(hostName: HTMLElement): void {
  element = document.createElement("div");
  element.style.cssText = "position: absolute; inset: 6px;";
  hostName.append(element);
  // ⌥-drag selects even while the agent's TUI captures the mouse.
  terminal = new Terminal({
    fontSize: 13,
    fontFamily: MONO_FALLBACK,
    cursorBlink: true,
    macOptionClickForcesSelection: true,
    // The agent's TUI picks colours for a dark screen: xterm lifts any that would be unreadable on a light sheet.
    minimumContrastRatio: 4.5,
    theme: palette(),
    // A link the agent prints (its sign-in address) opens in a tab. xterm's default asks through a confirm() and a
    // window.open(), which go nowhere in the browser's chrome.
    linkHandler: { activate: (_e, uri) => api.settings.openUrl(uri) },
  });
  const repaint = () => terminal && (terminal.options.theme = palette());
  new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", repaint);
  // Geist Mono is measured only once loaded: switching the family then makes xterm measure the cells again.
  void document.fonts.load(`13px "Geist Mono"`).then(() => {
    terminal!.options.fontFamily = `"Geist Mono", ${MONO_FALLBACK}`;
    adjust();
  });
  // ⌘C copies the selection: in the browser's chrome the copy command never reaches xterm's hidden textarea.
  terminal.attachCustomKeyEventHandler((e) => {
    // Échap closes Ressac's bubble first, never reaching the agent while one shows.
    if (e.key === "Escape" && bubble.current) {
      if (e.type === "keydown") dismissBubble();
      return false;
    }
    if (e.type !== "keydown" || !e.metaKey || e.key !== "c" || !terminal!.hasSelection()) return true;
    void navigator.clipboard.writeText(terminal!.getSelection()).catch(() => {});
    return false;
  });
  // OSC 52: a TUI that captures the mouse (Claude Code) selects text itself and copies it this way. Writes only: a
  // read request ("?") is ignored, the agent never reads the clipboard.
  terminal.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(";") + 1);
    if (!b64 || b64 === "?") return true;
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      void navigator.clipboard.writeText(text).catch(() => {});
    } catch {
      // Not base64: dropped.
    }
    return true;
  });
  adjustment = new FitAddon();
  terminal.loadAddon(adjustment);
  // Every paste path (⌘V, the context menu, a drop) is held before xterm sees it: captured on its parent, so xterm's own
  // paste listeners (textarea and element) never run and no original reaches the agent before the user's choice.
  const hold = (e: Event, data: DataTransfer | null) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    const text = data?.getData("text/plain");
    if (text) void holdPaste(text);
  };
  element.addEventListener("paste", (e) => hold(e, e.clipboardData), true);
  element.addEventListener("drop", (e) => hold(e, e.dataTransfer), true);
  element.addEventListener("dragover", (e) => e.preventDefault(), true);
  // The labels the agent prints: underlined, a click shows their value in the bubble.
  terminal.registerLinkProvider({
    provideLinks(y, callback) {
      const row = terminal!.buffer.active.getLine(y - 1);
      const links = (row ? labelsOn(row) : []).map(({ label, start, end }) => ({
        range: { start: { x: start + 1, y }, end: { x: end + 1, y } },
        text: label,
        activate: () => void reveal(label),
      }));
      callback(links.length ? links : undefined);
    },
  });
  terminal.open(element);
  adjustment.fit();
  terminal.onData((d) => api.agent.write(d, pasting));
  dataEnd = api.agent.onData((d) => {
    terminal!.write(d);
    flowing();
  });
  api.agent.start(size());
}

/**
 * Shows the terminal in `hote` (positioned, without inner padding: the terminal keeps a 6 px one); gives it back to
 * the previous host when the returned function is called.
 */
export function attacher(hostName: HTMLElement): () => void {
  dismissBubble();
  hosts.push(hostName);
  if (!element) create(hostName);
  else hostName.append(element);
  adjust();
  return () => {
    const i = hosts.lastIndexOf(hostName);
    if (i < 0) return;
    hosts.splice(i, 1);
    dismissBubble();
    const previous = hosts.at(-1);
    if (i === hosts.length && previous && element) {
      previous.append(element);
      adjust();
    }
  };
}

/** Recomputes columns and rows for the shown host; a hidden host (without a size) is not measured. */
export function adjust(): void {
  const hostName = hosts.at(-1);
  if (!terminal || !adjustment || !hostName || hostName.clientWidth === 0 || hostName.clientHeight === 0) return;
  const before = `${terminal.cols}x${terminal.rows}`;
  adjustment.fit();
  if (`${terminal.cols}x${terminal.rows}` !== before) api.agent.resize(size());
}

/** The window's terminal was made (a panel showed it once): a later session needs an explicit start. */
export const exists = (): boolean => !!terminal;

export function focus(): void {
  // The textarea alone is not enough: its frame must be the focused element of the window's document too.
  (window.frameElement as HTMLElement | null)?.focus();
  terminal?.focus();
}

/** The keyboard really goes to the terminal: its textarea is this document's active element, and this document is in the window's focus chain (the active element stays when the window's focus moves elsewhere). */
export function hasFocus(): boolean {
  return !!terminal?.textarea && terminal.textarea === document.activeElement && window.parent.document.activeElement === window.frameElement;
}

/** Set when AI goes off with a terminal: the host ended its session, the next shown host starts a new one. */
let asleep = false;
export function sleep(): void {
  if (terminal) asleep = true;
}
/** AI on again and a host shown: a session the switch-off ended starts afresh (once, whichever host asks). */
export function wake(): void {
  if (!asleep) return;
  asleep = false;
  reset();
}

/** New session (Réessayer, Relancer): the screen starts from scratch. */
export function reset(): void {
  terminal?.reset();
  api.agent.start(size());
}

// Hot reload (development): the old module gives back its subscriptions and its terminal, otherwise the agent's
// output would be written to a ghost terminal in addition to the new one.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    endState();
    dataEnd?.();
    terminal?.dispose();
    element?.remove();
  });
}
