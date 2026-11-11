<script lang="ts">
  // The page's error and crash messages.
  import type { Tab } from "../shared/model";
  import { api } from "./state.svelte";

  let { tab: tab }: { tab: Tab } = $props();
</script>

{#if tab.error}
  <div class="crashed">
    <p class="title">Impossible d'ouvrir cette page.</p>
    <p class="detail">{tab.url} — {tab.error}</p>
    <button onclick={() => api.navigate(tab.id, tab.url)}>Recharger</button>
  </div>
{:else if tab.crashed}
  <div class="crashed">
    <p class="title">Cette page a planté.</p>
    <button onclick={() => api.command(tab.id, "reload")}>Recharger</button>
  </div>
{/if}

<style>
  .crashed { display: grid; place-content: center; justify-items: center; gap: 10px; height: 100%; padding: 24px; text-align: center; color: var(--text); animation: webaios-rise var(--spring-d) var(--spring) backwards; }
  p { margin: 0; }
  .title { font: 650 26px/1.15 var(--font-display); letter-spacing: -0.02em; }
  .detail { max-width: 520px; color: var(--text-muted); font: 12px var(--font-mono); word-break: break-all; }
  button { margin-top: 8px; padding: 8px 18px; border-radius: 10px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); font: 600 13px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  button:hover { background: color-mix(in oklab, var(--accent) 88%, var(--text)); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
