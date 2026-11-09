<script lang="ts">
  import Figure from "./Figure.svelte";

  let { p }: { p: { figures: { value: string; label: string }[] } } = $props();
</script>

<div class="pa-chiffres" data-testid="bloc-chiffres">
  {#each p.figures as c, i (i)}<Figure p={c} testid="chiffre" />{/each}
</div>
