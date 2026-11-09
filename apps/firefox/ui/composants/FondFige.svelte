<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { TabId } from "../../shared/modele";
  import { api } from "../etat.svelte";
  import { modal } from "./modale.svelte";

  /**
   * Background of a window modal: the page shown at opening (`ongletId`, null: none, or a panel hides it), frozen
   * and blurred, under a veil. `surPret`: the capture is taken (or abandoned), the modal can show.
   */
  let { ongletId: tabId, surPret: onReady }: { ongletId: TabId | null; surPret: () => void } = $props();

  /** Beyond that, the page fades without a capture: the modal must not wait. */
  const PREVIEW_WAIT_MS = 1000;

  let preview = $state<string | null>(null);
  // Page area at capture time: the image stays there, even if the window is resized afterwards.
  let zone = $state(untrack(() => modal.zone));
  // The captured tab: if another one shows (or a panel), the frozen image is no longer the right page.
  const captureTab = untrack(() => tabId);
  $effect(() => {
    if (tabId !== captureTab) preview = null;
  });

  onMount(() => {
    let finished = false;
    // This background counts among the maskers once the capture is taken (or abandoned), and removes itself only once.
    let masque = false;
    const open = (url: string | null) => {
      if (finished) return;
      finished = true;
      preview = url;
      zone = modal.zone;
      // The capture is taken: the native view can fade behind the modal.
      masque = true;
      modal.masqueurs++;
      onReady();
    };
    const fallback = setTimeout(() => open(null), PREVIEW_WAIT_MS);
    api
      .apercuPage(captureTab)
      .then(open, () => open(null))
      .finally(() => clearTimeout(fallback));
    return () => {
      finished = true;
      clearTimeout(fallback);
      if (masque) modal.masqueurs--;
      masque = false;
    };
  });
</script>

{#if preview && zone}
  <div class="apercu" style:left="{zone.x}px" style:top="{zone.y}px" style:width="{zone.largeur}px" style:height="{zone.hauteur}px">
    <img data-testid="modale-apercu" src={preview} alt="" />
  </div>
{/if}
<div class="voile"></div>

<style>
  .apercu { position: fixed; overflow: hidden; }
  .apercu img { display: block; width: 100%; height: 100%; object-fit: cover; filter: blur(8px); transform: scale(1.03); }
  .voile { position: fixed; inset: 0; background: var(--voile); }
</style>
