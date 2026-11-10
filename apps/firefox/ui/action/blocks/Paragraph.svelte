<script lang="ts">
  let { p }: { p: { text: string } } = $props();
</script>

<p class="pa-paragraph" data-testid="block-paragraph">{p.text}</p>
