<script lang="ts">
  import type { Snippet } from "svelte";

  /** Two columns, stacked when the page is under 640 px (page.css). */
  let { gauche, droite: right }: { gauche: Snippet; droite: Snippet } = $props();
</script>

<div class="pa-colonnes" data-testid="bloc-colonnes">
  <div class="pa-blocs">{@render gauche()}</div>
  <div class="pa-blocs">{@render right()}</div>
</div>
