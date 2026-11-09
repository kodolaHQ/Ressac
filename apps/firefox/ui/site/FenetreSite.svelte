<script lang="ts">
  import { onMount } from "svelte";
  import SiteBar from "./BarreSite.svelte";
  import HomeFrame from "../SiteHomeFrame.svelte";
  import CarteAccordSite from "./CarteAccordSite.svelte";
  import type { SiteWindowState } from "../../shared/sites";
  import type { ApiSite } from "../../shared/api";

  /** The only API of this page: the main process knows which app it is the interface of. */
  const api = (window as unknown as { webaios: { site: ApiSite } }).webaios.site;
  let appState = $state<SiteWindowState | null>(null);

  onMount(() => {
    const fin = api.surEtat((e) => (appState = e));
    void api.etat().then((e) => {
      if (e && !appState) appState = e;
    });
    return fin;
  });
  $effect(() => {
    if (appState) document.title = appState.nom;
  });
</script>

{#if appState}
  <SiteBar etat={appState} {api} />
  <!-- Under the bar: the site's view (set by the main process) in « site » view, home otherwise. -->
  {#if appState.vue === "accueil"}
    <HomeFrame id={appState.id} {api} />
  {:else if appState.vue === "accord" && appState.accord}
    <CarteAccordSite accord={appState.accord} accorder={(yes, hash) => api.accorder(yes, hash)} />
  {/if}
{/if}

<style>
  :global(html), :global(body) { margin: 0; height: 100%; background: var(--fond); color: var(--texte); font: 13px system-ui, sans-serif; overflow: hidden; }
  :global(#app) { display: flex; flex-direction: column; height: 100%; }
</style>
