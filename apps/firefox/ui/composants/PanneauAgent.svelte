<script lang="ts">
  import { tick, untrack } from "svelte";
  import { api, etat as etatNavigateur } from "../etat.svelte";
  import { focusAgent } from "./agent.svelte";
  import * as terminalAgent from "./terminalAgent.svelte";

  let {
    visible,
    integre = false,
    redimensionner,
  }: {
    visible: boolean;
    /** In the builder's « Agent » tab: no width handle, always shown in its host. */
    integre?: boolean;
    /** The user drags the left edge: wanted width in pixels; `fin` on release. */
    redimensionner?: (largeur: number, fin: boolean) => void;
  } = $props();
  let section: HTMLElement;

  /** Dragging the left edge: the capture keeps the pointer even over the neighboring web page. */
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
  const etat = $derived(terminalAgent.agent.etat);

  let profils = $state<{ id: string; nom: string }[]>([]);
  const profilAgent = $derived(etatNavigateur.valeur?.reglages.profilAgent ?? "claude");
  $effect(() => {
    if (visible) api.agent.profils().then((p) => (profils = p), () => {});
  });
  // A single profile: nothing to choose. The menu stays if the chosen profile has disappeared, so it can be changed.
  const choixProfil = $derived(profils.length >= 2 || (profils.length > 0 && !profils.some((p) => p.id === profilAgent)));

  // The window's terminal comes here on the first opening of this panel, then stays attached: closing the panel only
  // hides it, the conversation goes on. The « Agent » tab borrows it while it is shown.
  // Becoming visible again (leaving the builder, the home page reopening it) does not take the keyboard: a keystroke
  // followed by Enter would go to the agent. Only an explicit request (focusAgent) gives it to the terminal.
  let detacher: (() => void) | undefined;
  $effect(() => () => detacher?.());
  $effect(() => {
    if (!visible) return;
    detacher ??= terminalAgent.attacher(hote);
    terminalAgent.ajuster();
    const obs = new ResizeObserver(() => terminalAgent.ajuster());
    obs.observe(hote);
    return () => obs.disconnect();
  });

  // Last focus request served. A request made while this panel is hidden does not concern it (⌘J in the builder
  // targets its « Agent » tab): it is dropped. The « Agent » tab, though, always shows on the user's request (click,
  // ⌘J, ✦): it takes the keyboard as soon as it is mounted.
  // svelte-ignore state_referenced_locally
  let servie = integre ? -1 : untrack(() => focusAgent.n);

  // ⌘J from a web page: the keyboard goes from the page to the interface. During this handover, Chromium ignores a
  // focus requested too early: it is requested again shortly after if the terminal does not have it.
  $effect(() => {
    const n = focusAgent.n;
    if (!visible) {
      servie = n;
      return;
    }
    if (n === servie) return;
    servie = n;
    const viser = () => visible && terminalAgent.focus();
    void tick().then(viser);
    const relance = setTimeout(() => !terminalAgent.aLeFocus() && viser(), 100);
    return () => clearTimeout(relance);
  });
</script>

<section class="agent" class:integre data-testid={integre ? "terminal-agent-integre" : "panneau-agent"} hidden={!visible} bind:this={section}>
  {#if !integre}
    <div class="poignee" data-testid="poignee-agent" role="separator" aria-orientation="vertical" aria-label="Largeur du panneau agent" onpointerdown={tirer}></div>
  {/if}
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
    <button onclick={terminalAgent.reinitialiser}>Réessayer</button>
  {:else if etat.etat === "erreur"}
    <p class="message">L'agent n'a pas pu démarrer : {etat.message}</p>
    <button onclick={terminalAgent.reinitialiser}>Réessayer</button>
  {:else if etat.etat === "termine"}
    <p class="message">L'agent s'est arrêté.</p>
    <button onclick={terminalAgent.reinitialiser}>Relancer</button>
  {/if}
  <div class="terminal" bind:this={hote} class:masque={etat.etat !== "actif" && etat.etat !== "termine"}></div>
</section>

<style>
  .agent { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--fond-barre); border-left: 1px solid var(--bord); }
  .agent[hidden] { display: none; }
  .agent.integre { flex: 1; border-left: none; }
  .poignee { position: absolute; top: 0; bottom: 0; left: -3px; width: 6px; cursor: col-resize; z-index: 1; }
  .poignee:hover, .poignee:active { background: color-mix(in srgb, var(--accent) 40%, transparent); }
  .message { margin: 12px; color: var(--texte-doux); }
  header { padding: 6px 8px; border-bottom: 1px solid var(--bord); }
  select { padding: 2px 6px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-actif); color: var(--texte); font-size: 12px; }
  button { margin: 0 12px 12px; align-self: flex-start; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-actif); color: var(--texte); }
  /* The terminal (terminalAgent) is placed in it absolutely, 6 px from the edge. */
  .terminal { position: relative; flex: 1; min-height: 0; background: #1e1e22; }
  .terminal.masque { visibility: hidden; }
</style>
