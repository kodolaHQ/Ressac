<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { TabId } from "../../shared/modele";
  import { api } from "../etat.svelte";
  import { modale } from "./modale.svelte";

  /**
   * Background of a window modal: the page shown at opening (`ongletId`, null: none, or a panel hides it), frozen
   * and blurred, under a veil. `surPret`: the capture is taken (or abandoned), the modal can show.
   */
  let { ongletId, surPret }: { ongletId: TabId | null; surPret: () => void } = $props();

  /** Beyond that, the page fades without a capture: the modal must not wait. */
  const ATTENTE_APERCU_MS = 1000;

  let apercu = $state<string | null>(null);
  // Page area at capture time: the image stays there, even if the window is resized afterwards.
  let zone = $state(untrack(() => modale.zone));
  // The captured tab: if another one shows (or a panel), the frozen image is no longer the right page.
  const ongletCapture = untrack(() => ongletId);
  $effect(() => {
    if (ongletId !== ongletCapture) apercu = null;
  });

  onMount(() => {
    let finie = false;
    // This background counts among the maskers once the capture is taken (or abandoned), and removes itself only once.
    let masque = false;
    const ouvrir = (url: string | null) => {
      if (finie) return;
      finie = true;
      apercu = url;
      zone = modale.zone;
      // The capture is taken: the native view can fade behind the modal.
      masque = true;
      modale.masqueurs++;
      surPret();
    };
    const secours = setTimeout(() => ouvrir(null), ATTENTE_APERCU_MS);
    api
      .apercuPage(ongletCapture)
      .then(ouvrir, () => ouvrir(null))
      .finally(() => clearTimeout(secours));
    return () => {
      finie = true;
      clearTimeout(secours);
      if (masque) modale.masqueurs--;
      masque = false;
    };
  });
</script>

{#if apercu && zone}
  <div class="apercu" style:left="{zone.x}px" style:top="{zone.y}px" style:width="{zone.largeur}px" style:height="{zone.hauteur}px">
    <img data-testid="modale-apercu" src={apercu} alt="" />
  </div>
{/if}
<div class="voile"></div>

<style>
  .apercu { position: fixed; overflow: hidden; }
  .apercu img { display: block; width: 100%; height: 100%; object-fit: cover; filter: blur(8px); transform: scale(1.03); }
  .voile { position: fixed; inset: 0; background: var(--voile); }
</style>
