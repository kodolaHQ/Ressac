<script lang="ts">
  let { p }: { p: { texte: string } } = $props();
</script>

<h2 class="pa-titre" data-testid="bloc-titre">{p.texte}</h2>
