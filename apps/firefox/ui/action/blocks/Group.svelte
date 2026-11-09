<script lang="ts">
  import type { Snippet } from "svelte";

  let { p, children }: { p: { title: string; collapsed: boolean }; children: Snippet } = $props();
</script>

<details class="pa-groupe" data-testid="bloc-groupe" open={!p.collapsed}>
  <summary class="pa-texte">{p.title}</summary>
  {@render children()}
</details>
