<script lang="ts">
  import { etAutres } from "../types";

  let { p }: { p: { niveau: "info" | "avis" | "attention"; titre: string | null; texte: string | null; elements: string[] | null; autres: number } } = $props();
</script>

<div class="pa-encadre {p.niveau}" data-testid="bloc-encadre" role="note">
  {#if p.titre}<strong class="pa-texte">{p.titre}</strong>{/if}
  {#if p.texte}<p>{p.texte}</p>{/if}
  {#if p.elements?.length}
    <ul>
      {#each p.elements as e, i (i)}<li class="pa-texte">{e}</li>{/each}
    </ul>
  {/if}
  {#if p.autres > 0}<p class="pa-autres">{etAutres(p.autres)}</p>{/if}
</div>
