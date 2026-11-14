<script lang="ts">
  import { onMount } from "svelte";
  import { site } from "./locale.svelte";
  import SiteBar from "./SiteBar.svelte";
  import HomeFrame from "../SiteHomeFrame.svelte";
  import SiteGrantCard from "./SiteGrantCard.svelte";
  import type { SiteWindowState } from "../../shared/sites";
  import type { ApiSite } from "../../shared/api";

  /** The only API of this page: the main process knows which app it is the interface of. */
  const api = (window as unknown as { ressac: { site: ApiSite } }).ressac.site;
  let appState = $state<SiteWindowState | null>(null);

  onMount(() => {
    const end = api.onState((e) => ((appState = e), (site.locale = e.locale)));
    void api.state().then((e) => {
      if (e && !appState) (appState = e), (site.locale = e.locale);
    });
    return end;
  });
  $effect(() => {
    if (appState) document.title = appState.name;
  });
</script>

{#if appState}
  <SiteBar state={appState} {api} />
  <!-- Under the bar: the site's view (set by the main process) in « site » view, home otherwise. -->
  {#if appState.viewState === "home"}
    <HomeFrame id={appState.id} {api} />
  {:else if appState.viewState === "grant" && appState.grant}
    <SiteGrantCard grant={appState.grant} onGrant={(yes, hash) => api.grant(yes, hash)} />
  {/if}
{/if}

<style>
  /* An app window has no aura behind it: its bar carries one, the default Aube washed into the base. */
  :global(html), :global(body) {
    margin: 0;
    height: 100%;
    background: linear-gradient(100deg, color-mix(in oklab, var(--a1) 60%, var(--bg)), color-mix(in oklab, var(--a2) 45%, var(--bg)) 55%, color-mix(in oklab, var(--a3) 55%, var(--bg)));
    color: var(--text);
    font: 13px/1.4 var(--font-ui);
    overflow: hidden;
  }
  :global(#app) { display: flex; flex-direction: column; height: 100%; }
</style>
