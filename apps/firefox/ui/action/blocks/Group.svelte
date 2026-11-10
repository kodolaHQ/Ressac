<script lang="ts">
  import type { Snippet } from "svelte";

  let { p, children }: { p: { title: string; collapsed: boolean }; children: Snippet } = $props();
</script>

<details class="pa-group" data-testid="block-group" open={!p.collapsed}>
  <summary class="pa-text">{p.title}</summary>
  {@render children()}
</details>
