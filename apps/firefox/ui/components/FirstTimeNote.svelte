<script lang="ts">
  import { fade } from "svelte/transition";
  import { FIRST_TIME, type FirstTimeId } from "../../shared/hints";
  import { firstTimePending, markSeen } from "./hints";

  /** `veil`: dims what is behind (the main window); in a frame of its own the note fills the frame. */
  let { id, veil = false }: { id: FirstTimeId; veil?: boolean } = $props();
  const note = $derived(FIRST_TIME[id]);
  let ok = $state<HTMLButtonElement>();
  $effect(() => ok?.focus());
</script>

<!-- Capture: Escape is the note's, it never reaches the terminal below. -->
<svelte:window onkeydowncapture={(e) => e.key === "Escape" && firstTimePending(id) && (e.preventDefault(), e.stopPropagation(), markSeen(id))} />

{#if firstTimePending(id)}
  <div class="layer" class:veil data-testid="first-time-{id}" out:fade={{ duration: 150 }}>
    <div class="card" role="dialog" aria-modal="true" aria-label={note.title}>
      <h2>{note.title}</h2>
      <p>{note.text}</p>
      <button bind:this={ok} type="button" data-testid="first-time-ok" onclick={() => markSeen(id)}>Compris</button>
    </div>
  </div>
{/if}

<style>
  .layer { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: 16px; }
  .veil { background: var(--overlay-veil); }
  .card { display: flex; flex-direction: column; gap: 10px; max-width: 340px; padding: 18px; border-radius: 16px; border: 1px solid var(--glass-edge); background: var(--glass-dense, var(--glass)); backdrop-filter: blur(20px); box-shadow: var(--float); color: var(--text); animation: webaios-rise var(--spring-d) var(--spring) backwards; }
  h2 { margin: 0; font: 650 22px/1.1 var(--font-display); letter-spacing: -0.02em; }
  p { margin: 0; font-size: 14px; line-height: 1.45; color: var(--text-muted); }
  button { align-self: flex-end; padding: 6px 14px; border-radius: 10px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); font: 600 13px var(--font-ui); transition: transform var(--tap); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
