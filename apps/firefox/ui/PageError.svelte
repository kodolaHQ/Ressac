<script lang="ts">
  // The page's error and crash messages.
  import type { Tab } from "../shared/model";
  import { api } from "./state.svelte";

  let { onglet: tab }: { onglet: Tab } = $props();
</script>

{#if tab.erreur}
  <div class="plante">
    <p>Impossible d'ouvrir cette page.</p>
    <p class="detail">{tab.url} — {tab.erreur}</p>
    <button onclick={() => api.naviguer(tab.id, tab.url)}>Recharger</button>
  </div>
{:else if tab.plante}
  <div class="plante">
    <p>Cette page a planté.</p>
    <button onclick={() => api.commande(tab.id, "recharger")}>Recharger</button>
  </div>
{/if}

<style>
  .detail { color: var(--texte-doux); font-size: 12px; word-break: break-all; }
  .plante { display: grid; place-content: center; gap: 12px; height: 100%; text-align: center; color: var(--texte); }
</style>
