<script lang="ts">
  import { andOthers } from "../types";

  let { p }: { p: { values: string[]; others: number } } = $props();
</script>

<div data-testid="block-labels">
  <div class="pa-tags">{#each p.values as v, i (i)}<span class="pa-tag">{v}</span>{/each}</div>
  {#if p.others > 0}<p class="pa-others">{andOthers(p.others)}</p>{/if}
</div>
