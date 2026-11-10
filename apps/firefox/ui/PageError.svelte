<script lang="ts">
  // The page's error and crash messages.
  import type { Tab } from "../shared/model";
  import { api } from "./state.svelte";

  let { tab: tab }: { tab: Tab } = $props();
</script>

{#if tab.error}
  <div class="crashed">
    <p>Impossible d'ouvrir cette page.</p>
    <p class="detail">{tab.url} — {tab.error}</p>
    <button onclick={() => api.navigate(tab.id, tab.url)}>Recharger</button>
  </div>
{:else if tab.crashed}
  <div class="crashed">
    <p>Cette page a planté.</p>
    <button onclick={() => api.command(tab.id, "reload")}>Recharger</button>
  </div>
{/if}

<style>
  .detail { color: var(--text-muted); font-size: 12px; word-break: break-all; }
  .crashed { display: grid; place-content: center; gap: 12px; height: 100%; text-align: center; color: var(--text); }
</style>
