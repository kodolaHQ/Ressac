<script lang="ts">
  import { onMount } from "svelte";
  import BarreSite from "./BarreSite.svelte";
  import CadreAccueil from "./CadreAccueil.svelte";
  import CarteAccordSite from "./CarteAccordSite.svelte";
  import type { EtatFenetreSite } from "../../shared/sites";
  import type { ApiSite } from "../../shared/api";

  /** L'unique API de cette page : le process principal sait de quelle appli elle est l'interface. */
  const api = (window as unknown as { webaios: { site: ApiSite } }).webaios.site;
  let etat = $state<EtatFenetreSite | null>(null);

  onMount(() => {
    const fin = api.surEtat((e) => (etat = e));
    void api.etat().then((e) => {
      if (e && !etat) etat = e;
    });
    return fin;
  });
  $effect(() => {
    if (etat) document.title = etat.nom;
  });
</script>

{#if etat}
  <BarreSite {etat} {api} />
  <!-- Sous la barre : la vue du site (posée par le process principal) en vue « site », l'accueil sinon. -->
  {#if etat.vue === "accueil"}
    <CadreAccueil id={etat.id} {api} />
  {:else if etat.vue === "accord" && etat.accord}
    <CarteAccordSite accord={etat.accord} accorder={(oui, empreinte) => api.accorder(oui, empreinte)} />
  {/if}
{/if}

<style>
  :global(html), :global(body) { margin: 0; height: 100%; background: var(--fond); color: var(--texte); font: 13px system-ui, sans-serif; overflow: hidden; }
  :global(#app) { display: flex; flex-direction: column; height: 100%; }
</style>
