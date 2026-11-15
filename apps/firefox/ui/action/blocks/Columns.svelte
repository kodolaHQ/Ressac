<script lang="ts">
  import type { Snippet } from "svelte";

  /** Two columns, stacked when the page is under 640 px (page.css). */
  let { left, right }: { left: Snippet; right: Snippet } = $props();
</script>

<div class="pa-columns" data-testid="block-columns">
  <div class="pa-blocks">{@render left()}</div>
  <div class="pa-blocks">{@render right()}</div>
</div>
