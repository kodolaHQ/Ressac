<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { IdOnglet } from "../../shared/modele";
  import { api } from "../etat.svelte";
  import { modale } from "./modale.svelte";

  /**
   * Fond d'une modale de la fenêtre : la page affichée à l'ouverture (`ongletId`, null : aucune, ou un panneau la
   * cache), figée et floutée, sous un voile. `surPret` : la capture est prise (ou abandonnée), la modale peut s'afficher.
   */
  let { ongletId, surPret }: { ongletId: IdOnglet | null; surPret: () => void } = $props();

  /** Au-delà, la page s'efface sans capture : la modale ne doit pas attendre. */
  const ATTENTE_APERCU_MS = 1000;

  let apercu = $state<string | null>(null);
  // Zone de la page au moment de la capture : l'image y reste, même si la fenêtre change ensuite de taille.
  let zone = $state(untrack(() => modale.zone));
  // L'onglet capturé : si un autre s'affiche (ou un panneau), l'image figée n'est plus la bonne page.
  const ongletCapture = untrack(() => ongletId);
  $effect(() => {
    if (ongletId !== ongletCapture) apercu = null;
  });

  onMount(() => {
    let finie = false;
    // Ce fond compte parmi les masqueurs dès que la capture est prise (ou abandonnée), et s'en retire une seule fois.
    let masque = false;
    const ouvrir = (url: string | null) => {
      if (finie) return;
      finie = true;
      apercu = url;
      zone = modale.zone;
      // La capture est prise : la vue native peut s'effacer derrière la modale.
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
