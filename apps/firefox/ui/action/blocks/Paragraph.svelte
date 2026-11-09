<script lang="ts">
  let { p }: { p: { text: string } } = $props();
</script>

<p class="pa-paragraphe" data-testid="bloc-paragraphe">{p.text}</p>
