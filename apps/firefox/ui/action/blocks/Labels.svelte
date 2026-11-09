<script lang="ts">
  import { andOthers } from "../types";

  let { p }: { p: { values: string[]; others: number } } = $props();
</script>

<div data-testid="bloc-etiquettes">
  <div class="pa-etiquettes">{#each p.values as v, i (i)}<span class="pa-etiquette">{v}</span>{/each}</div>
  {#if p.others > 0}<p class="pa-autres">{andOthers(p.others)}</p>{/if}
</div>
