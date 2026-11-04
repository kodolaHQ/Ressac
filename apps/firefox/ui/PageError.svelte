<script lang="ts">
  // Electron's ZoneContenu.svelte, its error and crash messages.
  import type { Onglet } from "../../navigateur/src/commun/modele";
  import { api } from "../../navigateur/src/renderer/etat.svelte";

  let { onglet }: { onglet: Onglet } = $props();
</script>

{#if onglet.erreur}
  <div class="plante">
    <p>Impossible d'ouvrir cette page.</p>
    <p class="detail">{onglet.url} — {onglet.erreur}</p>
    <button onclick={() => api.naviguer(onglet.id, onglet.url)}>Recharger</button>
  </div>
{:else if onglet.plante}
  <div class="plante">
    <p>Cette page a planté.</p>
    <button onclick={() => api.commande(onglet.id, "recharger")}>Recharger</button>
  </div>
{/if}

<style>
  .detail { color: var(--texte-doux); font-size: 12px; word-break: break-all; }
  .plante { display: grid; place-content: center; gap: 12px; height: 100%; text-align: center; color: var(--texte); }
</style>
