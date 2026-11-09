<script lang="ts">
  let { p }: { p: { text: string } } = $props();
</script>

<h2 class="pa-titre" data-testid="bloc-titre">{p.text}</h2>
