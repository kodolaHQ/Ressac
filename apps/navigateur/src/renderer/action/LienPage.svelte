<script lang="ts">
  import { api } from "../etat.svelte";
  import type { ContextePage, LienPage } from "./types";

  /**
   * Un lien de la page : un bouton, jamais un `<a href>` (le process principal n'ouvre l'adresse que si elle figure telle
   * quelle dans les résultats). Sans adresse permise, le texte seul.
   */
  let { lien, ctx }: { lien: LienPage; ctx: ContextePage } = $props();
</script>

{#if lien.url === null}
  <span class="pa-texte">{lien.texte}</span>
{:else}
  {@const url = lien.url}
  <button type="button" class="pa-lien" title={url} onclick={() => api.actions.ouvrirLien(ctx.action, ctx.execution, url)}>{lien.texte || url}</button>
{/if}
