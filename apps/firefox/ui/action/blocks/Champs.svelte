<script lang="ts">
  import { andOthers } from "../types";

  let { p }: { p: { champs: { libelle: string; valeur: string }[]; autres: number } } = $props();
</script>

<div data-testid="bloc-champs">
  <dl class="pa-champs">
    {#each p.champs as c, i (i)}<dt>{c.libelle}</dt><dd>{c.valeur || "—"}</dd>{/each}
  </dl>
  {#if p.autres > 0}<p class="pa-autres">{andOthers(p.autres)}</p>{/if}
</div>
