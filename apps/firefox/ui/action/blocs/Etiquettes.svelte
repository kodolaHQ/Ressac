<script lang="ts">
  import { etAutres } from "../types";

  let { p }: { p: { valeurs: string[]; autres: number } } = $props();
</script>

<div data-testid="bloc-etiquettes">
  <div class="pa-etiquettes">{#each p.valeurs as v, i (i)}<span class="pa-etiquette">{v}</span>{/each}</div>
  {#if p.autres > 0}<p class="pa-autres">{etAutres(p.autres)}</p>{/if}
</div>
