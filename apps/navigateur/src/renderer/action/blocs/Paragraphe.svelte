<script lang="ts">
  let { p }: { p: { texte: string } } = $props();
</script>

<p class="pa-paragraphe" data-testid="bloc-paragraphe">{p.texte}</p>
