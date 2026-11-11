import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AgentPanelState } from "../../shared/api";
import { api } from "../state.svelte";

/**
 * The window's agent terminal: **a single** xterm, subscribed only once to the session's data. The side panel and
 * the builder's « Agent » tab display it in turn by moving its element from one host to the other: two terminals
 * would receive the output twice and answer twice.
 */

/** What the window's agent shows (preparing, active, error…), the same for all hosts. */
export const agent = $state<{ state: AgentPanelState; busy: boolean }>({ state: { state: "preparing" }, busy: false });

/** The agent counts as answering while its output flows; this long a silence ends the answer. */
const BUSY_QUIET_MS = 900;
let quiet: ReturnType<typeof setTimeout> | undefined;
function flowing(): void {
  agent.busy = true;
  clearTimeout(quiet);
  quiet = setTimeout(() => (agent.busy = false), BUSY_QUIET_MS);
}

const MONO_FALLBACK = "ui-monospace, Menlo, monospace";
/** xterm paints with JS colours: read from the tokens, again when the theme or the space's aura changes. */
function palette() {
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
  if (e.state === "preparing" && agent.state.state !== "preparing") terminal?.reset();
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
  terminal.open(element);
  adjustment.fit();
  terminal.onData((d) => api.agent.write(d));
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
  hosts.push(hostName);
  if (!element) create(hostName);
  else hostName.append(element);
  adjust();
  return () => {
    const i = hosts.lastIndexOf(hostName);
    if (i < 0) return;
    hosts.splice(i, 1);
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

export function focus(): void {
  terminal?.focus();
}

export function hasFocus(): boolean {
  return !!terminal?.textarea && terminal.textarea === document.activeElement;
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
