import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { EtatPanneauAgent } from "../../shared/api";
import { api } from "../etat.svelte";

/**
 * Le terminal de l'agent de la fenêtre : **un seul** xterm, abonné une seule fois aux données de la session. Le panneau
 * latéral et l'onglet « Agent » du constructeur l'affichent tour à tour en déplaçant son élément d'un hôte à l'autre :
 * deux terminaux recevraient deux fois la sortie et répondraient deux fois.
 */

/** Ce que montre l'agent de la fenêtre (préparation, actif, erreur…), le même pour tous les hôtes. */
export const agent = $state<{ etat: EtatPanneauAgent }>({ etat: { etat: "preparation" } });

let terminal: Terminal | undefined;
let ajustement: FitAddon | undefined;
/** Où xterm s'est ouvert : cet élément passe d'un hôte à l'autre, xterm reste dedans. */
let element: HTMLDivElement | undefined;
/** Hôtes attachés, le dernier affiche le terminal ; en détacher un rend le terminal au précédent. */
const hotes: HTMLElement[] = [];

// Une session qui repart (Relancer, changement de profil) efface l'écran de la précédente.
const finEtat = api.agent.surEtat((e) => {
  if (e.etat === "preparation" && agent.etat.etat !== "preparation") terminal?.reset();
  agent.etat = e;
});
let finDonnees: (() => void) | undefined;

const taille = () => ({ cols: Math.max(2, terminal?.cols ?? 80), rows: Math.max(2, terminal?.rows ?? 24) });

/** Le terminal naît au premier hôte affiché (il faut une taille pour le mesurer) ; la session de la fenêtre démarre avec lui. */
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
 * Affiche le terminal dans `hote` (positionné, sans marge intérieure : le terminal en garde une de 6 px) ; le rend à
 * l'hôte précédent quand on appelle la fonction rendue.
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

/** Recalcule colonnes et lignes pour l'hôte affiché ; un hôte caché (sans taille) n'est pas mesuré. */
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

/** Nouvelle session (Réessayer, Relancer) : l'écran repart de zéro. */
export function reinitialiser(): void {
  terminal?.reset();
  api.agent.demarrer(taille());
}

// Rechargement à chaud (développement) : l'ancien module rend ses abonnements et son terminal, sinon la sortie de
// l'agent s'écrirait dans un terminal fantôme en plus du nouveau.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    finEtat();
    finDonnees?.();
    terminal?.dispose();
    element?.remove();
  });
}
