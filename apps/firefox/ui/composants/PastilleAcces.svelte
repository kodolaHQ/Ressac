<script lang="ts">
  import type { EtatAccesOnglet } from "@webaios/noyau";
  import BulleAcces from "./BulleAcces.svelte";

  let { id, etat }: { id: string; etat: EtatAccesOnglet } = $props();
  const niveau = $derived(etat.droits.includes("agir") ? "agir" : "lecture");
  let ouverte = $state(false);
  let racine = $state<HTMLSpanElement>();

  /** A click elsewhere (outside the badge and its bubble) or Escape closes the bubble. */
  function dehors(e: PointerEvent) {
    if (ouverte && !racine?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-testid="bulle-acces"]')) ouverte = false;
  }
</script>

<svelte:window onpointerdown={dehors} onblur={() => (ouverte = false)} onkeydown={(e) => e.key === "Escape" && (ouverte = false)} />

<span class="racine" bind:this={racine}>
  <button
    class="pastille"
    class:pulse={etat.enCours}
    data-testid="pastille-acces"
    data-niveau={niveau}
    aria-label="Accès de l'agent à cet onglet"
    aria-expanded={ouverte}
    draggable="false"
    onclick={(e) => {
      e.stopPropagation(); // do not activate the tab
      ouverte = !ouverte;
    }}
    onkeydown={(e) => e.stopPropagation()}
    ondblclick={(e) => e.stopPropagation()}>{niveau === "agir" ? "⚡" : "👁"}</button
  >
  {#if ouverte && racine}<BulleAcces {id} {etat} ancre={racine} />{/if}
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
