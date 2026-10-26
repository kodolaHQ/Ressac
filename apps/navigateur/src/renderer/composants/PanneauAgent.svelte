<script lang="ts">
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import type { EtatPanneauAgent } from "../../commun/api";
  import { tick } from "svelte";
  import { api, etat as etatNavigateur } from "../etat.svelte";
  import { focusAgent } from "./agent.svelte";

  let {
    visible,
    redimensionner,
  }: {
    visible: boolean;
    /** L'utilisateur tire le bord gauche : largeur voulue en pixels ; `fin` au lâcher. */
    redimensionner?: (largeur: number, fin: boolean) => void;
  } = $props();
  let section: HTMLElement;

  /** Tirer le bord gauche : la capture garde le pointeur même au-dessus de la page web voisine. */
  function tirer(e: PointerEvent) {
    const poignee = e.currentTarget as HTMLElement;
    poignee.setPointerCapture(e.pointerId);
    const depart = e.clientX;
    const largeur = section.getBoundingClientRect().width;
    const voulue = (ev: PointerEvent) => largeur + depart - ev.clientX;
    const bouger = (ev: PointerEvent) => redimensionner?.(voulue(ev), false);
    const lacher = (ev: PointerEvent) => {
      poignee.removeEventListener("pointermove", bouger);
      poignee.removeEventListener("pointerup", lacher);
      poignee.removeEventListener("pointercancel", lacher);
      redimensionner?.(voulue(ev), true);
    };
    poignee.addEventListener("pointermove", bouger);
    poignee.addEventListener("pointerup", lacher);
    poignee.addEventListener("pointercancel", lacher);
  }
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

  // Une session qui repart (Relancer, changement de profil) efface l'écran de la précédente.
  $effect(() =>
    api.agent.surEtat((e) => {
      if (e.etat === "preparation" && etat.etat !== "preparation") terminal?.reset();
      etat = e;
    }),
  );

  let profils = $state<{ id: string; nom: string }[]>([]);
  const profilAgent = $derived(etatNavigateur.valeur?.reglages.profilAgent ?? "claude");
  $effect(() => {
    if (visible) api.agent.profils().then((p) => (profils = p), () => {});
  });
  // Un seul profil : rien à choisir. Le menu reste si le profil choisi a disparu, pour pouvoir en changer.
  const choixProfil = $derived(profils.length >= 2 || (profils.length > 0 && !profils.some((p) => p.id === profilAgent)));

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

  // ⌘J depuis une page web : le clavier passe de la page à l'interface. Pendant ce passage, Chromium ignore un
  // focus demandé trop tôt : on le redemande peu après si le terminal ne l'a pas.
  $effect(() => {
    if (!focusAgent.n) return;
    const viser = () => visible && terminal?.focus();
    void tick().then(viser);
    const relance = setTimeout(() => terminal?.textarea !== document.activeElement && viser(), 100);
    return () => clearTimeout(relance);
  });
</script>

<section class="agent" data-testid="panneau-agent" hidden={!visible} bind:this={section}>
  <div class="poignee" data-testid="poignee-agent" role="separator" aria-orientation="vertical" aria-label="Largeur du panneau agent" onpointerdown={tirer}></div>
  {#if choixProfil}
    <header>
      <select
        data-testid="profil-agent"
        aria-label="Profil d'agent"
        value={profilAgent}
        onchange={(e) => api.agir({ type: "choisirProfilAgent", profil: e.currentTarget.value })}
      >
        {#each profils as p (p.id)}<option value={p.id}>{p.nom}</option>{/each}
      </select>
    </header>
  {/if}
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
  .agent { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--fond-barre); border-left: 1px solid var(--bord); }
  .agent[hidden] { display: none; }
  .poignee { position: absolute; top: 0; bottom: 0; left: -3px; width: 6px; cursor: col-resize; z-index: 1; }
  .poignee:hover, .poignee:active { background: color-mix(in srgb, var(--accent) 40%, transparent); }
  .message { margin: 12px; color: var(--texte-doux); }
  header { padding: 6px 8px; border-bottom: 1px solid var(--bord); }
  select { padding: 2px 6px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-actif); color: var(--texte); font-size: 12px; }
  button { margin: 0 12px 12px; align-self: flex-start; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-actif); color: var(--texte); }
  .terminal { flex: 1; min-height: 0; padding: 6px; background: #1e1e22; }
  .terminal.masque { visibility: hidden; }
</style>
