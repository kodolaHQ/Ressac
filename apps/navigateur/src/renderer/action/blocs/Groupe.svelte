<script lang="ts">
  import type { Snippet } from "svelte";

  let { p, children }: { p: { titre: string; replie: boolean }; children: Snippet } = $props();
</script>

<details class="pa-groupe" data-testid="bloc-groupe" open={!p.replie}>
  <summary class="pa-texte">{p.titre}</summary>
  {@render children()}
</details>
