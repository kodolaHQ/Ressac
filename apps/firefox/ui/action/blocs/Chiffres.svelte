<script lang="ts">
  import Chiffre from "./Chiffre.svelte";

  let { p }: { p: { chiffres: { valeur: string; libelle: string }[] } } = $props();
</script>

<div class="pa-chiffres" data-testid="bloc-chiffres">
  {#each p.chiffres as c, i (i)}<Chiffre p={c} testid="chiffre" />{/each}
</div>
