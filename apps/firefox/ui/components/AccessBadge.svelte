<script lang="ts">
  import type { TabAccessState } from "@webaios/kernel";
  import AccessBubble from "./AccessBubble.svelte";

  let { id, state: appState }: { id: string; state: TabAccessState } = $props();
  const level = $derived(appState.rights.includes("agir") ? "agir" : "lecture");
  let opened = $state(false);
  let root = $state<HTMLSpanElement>();

  /** A click elsewhere (outside the badge and its bubble) or Escape closes the bubble. */
  function outside(e: PointerEvent) {
    if (opened && !root?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-testid="bulle-acces"]')) opened = false;
  }
</script>

<svelte:window onpointerdown={outside} onblur={() => (opened = false)} onkeydown={(e) => e.key === "Escape" && (opened = false)} />

<span class="racine" bind:this={root}>
  <button
    class="pastille"
    class:pulse={appState.running}
    data-testid="pastille-acces"
    data-niveau={level}
    aria-label="Accès de l'agent à cet onglet"
    aria-expanded={opened}
    draggable="false"
    onclick={(e) => {
      e.stopPropagation(); // do not activate the tab
      opened = !opened;
    }}
    onkeydown={(e) => e.stopPropagation()}
    ondblclick={(e) => e.stopPropagation()}>{level === "agir" ? "⚡" : "👁"}</button
  >
  {#if opened && root}<AccessBubble {id} state={appState} anchor={root} />{/if}
</span>

<style>
  .racine { display: inline-flex; flex: none; -webkit-app-region: no-drag; }
  .pastille { all: unset; display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 7px; font-size: 11px; font-weight: 600; cursor: pointer; }
  .pastille[data-niveau="lecture"] { background: var(--acces-lecture-fond); color: var(--acces-lecture); }
  .pastille[data-niveau="agir"] { background: var(--acces-agir-fond); color: var(--acces-agir); }
  .pastille.pulse { animation: bat 1s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) {
    .pastille.pulse { animation: none; outline: 2px solid currentColor; outline-offset: 1px; }
  }
  @keyframes bat { 50% { opacity: 0.35; } }
</style>
