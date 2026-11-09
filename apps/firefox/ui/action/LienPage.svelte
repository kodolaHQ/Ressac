<script lang="ts">
  import { api } from "../etat.svelte";
  import type { ContextePage, LienPage } from "./types";

  /**
   * A page link: a button, never an `<a href>` (the main process only opens the address if it appears as is in the
   * results). Without a permitted address, the text alone.
   */
  let { lien, ctx }: { lien: LienPage; ctx: ContextePage } = $props();
</script>

{#if lien.url === null}
  <span class="pa-texte">{lien.texte}</span>
{:else}
  {@const url = lien.url}
  <button type="button" class="pa-lien" title={url} onclick={() => api.actions.ouvrirLien(ctx.action, ctx.execution, url)}>{lien.texte || url}</button>
{/if}
