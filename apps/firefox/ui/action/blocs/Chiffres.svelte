<script lang="ts">
  import Figure from "./Chiffre.svelte";

  let { p }: { p: { chiffres: { valeur: string; libelle: string }[] } } = $props();
</script>

<div class="pa-chiffres" data-testid="bloc-chiffres">
  {#each p.chiffres as c, i (i)}<Figure p={c} testid="chiffre" />{/each}
</div>
