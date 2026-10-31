<script lang="ts">
  import type { Snippet } from "svelte";

  /** Deux colonnes, empilées quand la page fait moins de 640 px (page.css). */
  let { gauche, droite }: { gauche: Snippet; droite: Snippet } = $props();
</script>

<div class="pa-colonnes" data-testid="bloc-colonnes">
  <div class="pa-blocs">{@render gauche()}</div>
  <div class="pa-blocs">{@render droite()}</div>
</div>
