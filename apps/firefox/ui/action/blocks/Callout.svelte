<script lang="ts">
  import { andOthers } from "../types";

  let { p }: { p: { level: "info" | "avis" | "attention"; title: string | null; text: string | null; items: string[] | null; others: number } } = $props();
</script>

<div class="pa-encadre {p.level}" data-testid="bloc-encadre" role="note">
  {#if p.title}<strong class="pa-texte">{p.title}</strong>{/if}
  {#if p.text}<p>{p.text}</p>{/if}
  {#if p.items?.length}
    <ul>
      {#each p.items as e, i (i)}<li class="pa-texte">{e}</li>{/each}
    </ul>
  {/if}
  {#if p.others > 0}<p class="pa-autres">{andOthers(p.others)}</p>{/if}
</div>
