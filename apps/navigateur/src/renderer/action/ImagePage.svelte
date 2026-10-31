<script lang="ts">
  import { urlImage } from "../../commun/actions";
  import type { ContextePage, ImagePage } from "./types";

  /**
   * Une image des résultats, cherchée par le process principal (`webaios-image:`, sans cookies ni référent). Neutre (action
   * avec compte) ou en échec : un emplacement neutre de même taille.
   */
  let { image, ctx }: { image: NonNullable<ImagePage>; ctx: ContextePage } = $props();
  let echec = $state(false);
</script>

{#if "url" in image && !echec}
  <img class="pa-image" src={urlImage(ctx.action, ctx.execution, image.url)} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={() => (echec = true)} />
{:else}
  <div class="pa-image-neutre" data-testid="image-neutre" aria-hidden="true"></div>
{/if}
