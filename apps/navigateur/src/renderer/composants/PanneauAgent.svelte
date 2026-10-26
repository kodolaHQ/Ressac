<script lang="ts">
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import type { EtatPanneauAgent } from "../../commun/api";
  import { api } from "../etat.svelte";

  let { visible }: { visible: boolean } = $props();
  let hote: HTMLDivElement;
  let etat = $state<EtatPanneauAgent>({ etat: "preparation" });
  let terminal: Terminal | undefined;
  let ajustement: FitAddon | undefined;

  const taille = () => ({ cols: Math.max(2, terminal?.cols ?? 80), rows: Math.max(2, terminal?.rows ?? 24) });

  function ajuster() {
    if (!terminal || !ajustement || !visible) return;
    const avant = `${terminal.cols}x${terminal.rows}`;
    ajustement.fit();
    if (`${terminal.cols}x${terminal.rows}` !== avant) api.agent.redimensionner(taille());
  }

  /** Nouvelle session (première ouverture, Réessayer, Relancer) : l'écran repart de zéro. */
  function demarrer() {
    terminal?.reset();
    api.agent.demarrer(taille());
  }

  $effect(() => api.agent.surEtat((e) => (etat = e)));

  // Le terminal naît à la première ouverture du panneau (il faut une taille pour le mesurer), puis reste monté :
  // fermer le panneau ne fait que le cacher, la conversation continue.
  $effect(() => {
    if (!visible) return;
    if (!terminal) {
      terminal = new Terminal({ fontSize: 13, cursorBlink: true, theme: { background: "#1e1e22" } });
      ajustement = new FitAddon();
      terminal.loadAddon(ajustement);
      terminal.open(hote);
      ajustement.fit();
      terminal.onData((d) => api.agent.ecrire(d));
      api.agent.surDonnees((d) => terminal!.write(d));
      api.agent.demarrer(taille());
    }
    ajuster();
    terminal.focus();
    const obs = new ResizeObserver(ajuster);
    obs.observe(hote);
    return () => obs.disconnect();
  });
</script>

<section class="agent" data-testid="panneau-agent" hidden={!visible}>
  {#if etat.etat === "preparation"}
    <p class="message">Préparation de l'agent… (la première fois, la construction du conteneur prend quelques minutes)</p>
  {:else if etat.etat === "docker-absent"}
    <p class="message">Docker n'est pas lancé. La navigation fonctionne ; seul l'agent est indisponible.</p>
    <button onclick={demarrer}>Réessayer</button>
  {:else if etat.etat === "erreur"}
    <p class="message">L'agent n'a pas pu démarrer : {etat.message}</p>
    <button onclick={demarrer}>Réessayer</button>
  {:else if etat.etat === "termine"}
    <p class="message">L'agent s'est arrêté.</p>
    <button onclick={demarrer}>Relancer</button>
  {/if}
  <div class="terminal" bind:this={hote} class:masque={etat.etat !== "actif" && etat.etat !== "termine"}></div>
</section>

<style>
  .agent { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--fond-barre); border-left: 1px solid var(--bord); }
  .agent[hidden] { display: none; }
  .message { margin: 12px; color: var(--texte-doux); }
  button { margin: 0 12px 12px; align-self: flex-start; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-actif); color: var(--texte); }
  .terminal { flex: 1; min-height: 0; padding: 6px; background: #1e1e22; }
  .terminal.masque { visibility: hidden; }
</style>
