<script lang="ts">
  import type { TabAccessState } from "@ressac/kernel";
  import AccessBubble from "./AccessBubble.svelte";

  let { id, state: appState }: { id: string; state: TabAccessState } = $props();
  const level = $derived(appState.rights.includes("act") ? "act" : "read");
  let opened = $state(false);
  let root = $state<HTMLSpanElement>();

  /** A click elsewhere (outside the badge and its bubble) or Escape closes the bubble. */
  function outside(e: PointerEvent) {
    if (opened && !root?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-testid="access-bubble"]')) opened = false;
  }
</script>

<svelte:window onpointerdown={outside} onblur={() => (opened = false)} onkeydown={(e) => e.key === "Escape" && (opened = false)} />

<span class="root" bind:this={root}>
  <button
    class="pill"
    class:pulse={appState.running}
    data-testid="access-pill"
    data-level={level}
    aria-label="Accès de l'agent à cet onglet"
    aria-expanded={opened}
    draggable="false"
    onclick={(e) => {
      e.stopPropagation(); // do not activate the tab
      opened = !opened;
    }}
    onkeydown={(e) => e.stopPropagation()}
    ondblclick={(e) => e.stopPropagation()}>{level === "act" ? "⚡" : "👁"}</button
  >
  {#if opened && root}<AccessBubble {id} state={appState} anchor={root} />{/if}
</span>

<style>
  .root { display: inline-flex; flex: none; -webkit-app-region: no-drag; }
  .pill { all: unset; display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 7px; font-size: 11px; font-weight: 600; cursor: pointer; box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 22%, transparent); transition: transform var(--tap); }
  .pill:active { transform: scale(0.97); }
  .pill[data-level="read"] { background: var(--access-read-bg); color: var(--access-read); }
  .pill[data-level="act"] { background: var(--access-act-bg); color: var(--access-act); }
  .pill.pulse { animation: bat 1s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) {
    .pill.pulse { animation: none; outline: 2px solid currentColor; outline-offset: 1px; }
  }
  @keyframes bat { 50% { opacity: 0.35; } }
</style>
