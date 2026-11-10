<script lang="ts">
  let { p }: { p: { text: string } } = $props();
</script>

<h2 class="pa-title" data-testid="block-title">{p.text}</h2>
