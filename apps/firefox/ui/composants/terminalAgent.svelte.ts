import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { EtatPanneauAgent } from "../../shared/api";
import { api } from "../etat.svelte";

/**
 * The window's agent terminal: **a single** xterm, subscribed only once to the session's data. The side panel and
 * the builder's « Agent » tab display it in turn by moving its element from one host to the other: two terminals
 * would receive the output twice and answer twice.
 */

/** What the window's agent shows (preparing, active, error…), the same for all hosts. */
export const agent = $state<{ etat: EtatPanneauAgent }>({ etat: { etat: "preparation" } });

let terminal: Terminal | undefined;
let ajustement: FitAddon | undefined;
/** Where xterm opened: this element moves from one host to another, xterm stays inside. */
let element: HTMLDivElement | undefined;
/** Attached hosts, the last one shows the terminal; detaching one gives the terminal back to the previous one. */
const hotes: HTMLElement[] = [];

// A restarting session (Relancer, profile change) clears the previous one's screen.
const finEtat = api.agent.surEtat((e) => {
  if (e.etat === "preparation" && agent.etat.etat !== "preparation") terminal?.reset();
  agent.etat = e;
});
let finDonnees: (() => void) | undefined;

const taille = () => ({ cols: Math.max(2, terminal?.cols ?? 80), rows: Math.max(2, terminal?.rows ?? 24) });

/** The terminal is born at the first shown host (a size is needed to measure it); the window's session starts with it. */
function creer(hote: HTMLElement): void {
  element = document.createElement("div");
  element.style.cssText = "position: absolute; inset: 6px;";
  hote.append(element);
  terminal = new Terminal({ fontSize: 13, cursorBlink: true, theme: { background: "#1e1e22" } });
  ajustement = new FitAddon();
  terminal.loadAddon(ajustement);
  terminal.open(element);
  ajustement.fit();
  terminal.onData((d) => api.agent.ecrire(d));
  finDonnees = api.agent.surDonnees((d) => terminal!.write(d));
  api.agent.demarrer(taille());
}

/**
 * Shows the terminal in `hote` (positioned, without inner padding: the terminal keeps a 6 px one); gives it back to
 * the previous host when the returned function is called.
 */
export function attacher(hote: HTMLElement): () => void {
  hotes.push(hote);
  if (!element) creer(hote);
  else hote.append(element);
  ajuster();
  return () => {
    const i = hotes.lastIndexOf(hote);
    if (i < 0) return;
    hotes.splice(i, 1);
    const precedent = hotes.at(-1);
    if (i === hotes.length && precedent && element) {
      precedent.append(element);
      ajuster();
    }
  };
}

/** Recomputes columns and rows for the shown host; a hidden host (without a size) is not measured. */
export function ajuster(): void {
  const hote = hotes.at(-1);
  if (!terminal || !ajustement || !hote || hote.clientWidth === 0 || hote.clientHeight === 0) return;
  const avant = `${terminal.cols}x${terminal.rows}`;
  ajustement.fit();
  if (`${terminal.cols}x${terminal.rows}` !== avant) api.agent.redimensionner(taille());
}

export function focus(): void {
  terminal?.focus();
}

export function aLeFocus(): boolean {
  return !!terminal?.textarea && terminal.textarea === document.activeElement;
}

/** New session (Réessayer, Relancer): the screen starts from scratch. */
export function reinitialiser(): void {
  terminal?.reset();
  api.agent.demarrer(taille());
}

// Hot reload (development): the old module gives back its subscriptions and its terminal, otherwise the agent's
// output would be written to a ghost terminal in addition to the new one.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    finEtat();
    finDonnees?.();
    terminal?.dispose();
    element?.remove();
  });
}
