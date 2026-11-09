<script lang="ts">
  import { andOthers } from "../types";

  let { p }: { p: { fields: { label: string; value: string }[]; others: number } } = $props();
</script>

<div data-testid="bloc-champs">
  <dl class="pa-champs">
    {#each p.fields as c, i (i)}<dt>{c.label}</dt><dd>{c.value || "—"}</dd>{/each}
  </dl>
  {#if p.others > 0}<p class="pa-autres">{andOthers(p.others)}</p>{/if}
</div>
