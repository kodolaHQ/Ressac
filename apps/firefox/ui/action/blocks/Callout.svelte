<script lang="ts">
  import { andOthers } from "../types";

  let { p }: { p: { level: "info" | "notice" | "warning"; title: string | null; text: string | null; items: string[] | null; others: number } } = $props();
</script>

<div class="pa-callout {p.level}" data-testid="block-callout" role="note">
  {#if p.title}<strong class="pa-text">{p.title}</strong>{/if}
  {#if p.text}<p>{p.text}</p>{/if}
  {#if p.items?.length}
    <ul>
      {#each p.items as e, i (i)}<li class="pa-text">{e}</li>{/each}
    </ul>
  {/if}
  {#if p.others > 0}<p class="pa-others">{andOthers(p.others)}</p>{/if}
</div>
