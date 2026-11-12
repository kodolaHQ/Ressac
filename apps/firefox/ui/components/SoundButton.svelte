<script lang="ts">
  import { fade } from "svelte/transition";
  import type { Tab } from "../../shared/model";
  import Icon from "./Icon.svelte";

  /** Where the sound comes from: shown on a tab that plays sound or is muted; a click mutes or unmutes it. */
  let { tab, size = 14 }: { tab: Tab; size?: number } = $props();
  const label = $derived(tab.sound === "muted" ? "Réactiver le son de l'onglet" : "Couper le son de l'onglet");
</script>

{#if tab.sound}
  <button
    class="sound"
    class:muted={tab.sound === "muted"}
    data-testid="tab-sound"
    aria-pressed={tab.sound === "muted"}
    aria-label={label}
    title={label}
    out:fade={{ duration: 150 }}
    onclick={(e) => {
      e.stopPropagation();
      window.parent.webaiosWindow?.toggleMute(tab.id);
    }}><Icon name={tab.sound === "muted" ? "sound-off" : "sound"} {size} /></button
  >
{/if}

<style>
  .sound { all: unset; flex: none; display: grid; place-content: center; width: 20px; height: 20px; border-radius: 6px; color: var(--text-muted); -moz-window-dragging: no-drag; animation: webaios-rise var(--spring-d) var(--spring) backwards; transition: transform var(--tap), background var(--tap), color var(--tap); }
  .sound:hover { background: var(--glass-hi); color: var(--text); }
  .sound:active { transform: scale(0.97); }
  .sound:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .sound.muted { color: var(--in-error); }
  @media (prefers-reduced-motion: reduce) { .sound { animation: none; } }
</style>
