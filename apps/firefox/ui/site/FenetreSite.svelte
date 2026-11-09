<script lang="ts">
  import { onMount } from "svelte";
  import BarreSite from "./BarreSite.svelte";
  import CadreAccueil from "../SiteHomeFrame.svelte";
  import CarteAccordSite from "./CarteAccordSite.svelte";
  import type { SiteWindowState } from "../../shared/sites";
  import type { ApiSite } from "../../shared/api";

  /** The only API of this page: the main process knows which app it is the interface of. */
  const api = (window as unknown as { webaios: { site: ApiSite } }).webaios.site;
  let etat = $state<SiteWindowState | null>(null);

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
  <!-- Under the bar: the site's view (set by the main process) in « site » view, home otherwise. -->
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
