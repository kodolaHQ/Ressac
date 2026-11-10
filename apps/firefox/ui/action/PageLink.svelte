<script lang="ts">
  import { api } from "../state.svelte";
  import type { PageContext, LinkRef } from "./types";

  /**
   * A page link: a button, never an `<a href>` (the main process only opens the address if it appears as is in the
   * results). Without a permitted address, the text alone.
   */
  let { link: link, ctx }: { link: LinkRef; ctx: PageContext } = $props();
</script>

{#if link.url === null}
  <span class="pa-text">{link.text}</span>
{:else}
  {@const url = link.url}
  <button type="button" class="pa-link" title={url} onclick={() => api.actions.openLink(ctx.action, ctx.run, url)}>{link.text || url}</button>
{/if}
