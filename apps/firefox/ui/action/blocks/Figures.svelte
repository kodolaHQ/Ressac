<script lang="ts">
  import Figure from "./Figure.svelte";

  let { p }: { p: { figures: { value: string; label: string }[] } } = $props();
</script>

<div class="pa-figures" data-testid="block-figures">
  {#each p.figures as c, i (i)}<Figure p={c} testid="figure" />{/each}
</div>
