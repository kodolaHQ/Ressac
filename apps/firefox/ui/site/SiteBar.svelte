<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import SiteDesignButton from "./SiteDesignButton.svelte";
  import SiteExtensionsButtons from "../SiteAddonsStrip.svelte";
  import { SITE_BAR_HEIGHT, SEARCH_URL, blockedLink, OPEN_IN_A_TAB, type SiteWindowState } from "../../shared/sites";
  import type { ApiSite } from "../../shared/api";

  let { etat: appState, api }: { etat: SiteWindowState; api: ApiSite } = $props();
  /** macOS: the window buttons are in the bar, on the left. */
  const mac = navigator.userAgent.includes("Mac");
  const onSite = $derived(appState.vue === "site");
  /** The design mode chevron unfolds its entries in place of the title. */
  let menuDesign = $state(false);
</script>

<!-- The background is draggable (moves the window); each button and the mention are clickable (no-drag). -->
<header data-testid="barre-site" class:mac style:height="{SITE_BAR_HEIGHT}px">
  <nav>
    <button data-testid="site-precedent" aria-label="Reculer" disabled={!onSite || !appState.peutReculer} onclick={() => api.precedent()}><Icon nom="reculer" /></button>
    <button data-testid="site-suivant" aria-label="Avancer" disabled={!onSite || !appState.peutAvancer} onclick={() => api.suivant()}><Icon nom="avancer" /></button>
    {#if appState.aAccueil}
      <button data-testid="site-accueil" aria-label="Accueil de l'appli" aria-pressed={appState.vue === "accueil"} disabled={appState.vue === "accord"} onclick={() => api.accueil()}><Icon nom="accueil" /></button>
    {/if}
    <button data-testid="site-recharger" aria-label="Recharger" disabled={!onSite} onclick={() => api.recharger()}><Icon nom="recharger" /></button>
  </nav>
  <div class="titre">
    {#if !menuDesign}
      <span data-testid="site-nom" class="nom">{appState.nom}</span>
      <span data-testid="site-domaine" class="domaine">{appState.domaine}</span>
    {/if}
  </div>
  {#if appState.suivi && onSite}
    <button data-testid="site-chercher-adresse" class="chercher" disabled={appState.recherche} aria-busy={appState.recherche} onclick={() => api.chercherAdresse()}>{SEARCH_URL}</button>
  {/if}
  {#if appState.avis}
    <div data-testid="site-avis" class="avis" data-genre={appState.avis.genre} role="status">
      {#if appState.avis.genre === "lien-bloque"}
        <span>{blockedLink(appState.avis.domaine)}</span>
        <button data-testid="site-ouvrir-onglet" onclick={() => api.ouvrirBloque()}>{OPEN_IN_A_TAB}</button>
      {:else}
        <span>{appState.avis.texte}</span>
      {/if}
    </div>
  {/if}
  <!-- Right: the design mode (every view), then the active add-ons' buttons (« site » view only). -->
  <div class="extensions">
    <SiteDesignButton {api} etat={appState} bind:menuOuvert={menuDesign} />
    <SiteExtensionsButtons {api} surSite={onSite} />
  </div>
</header>

<style>
  header { display: flex; align-items: center; gap: 10px; padding: 0 8px; box-sizing: border-box; background: var(--fond-barre); border-bottom: 1px solid var(--bord); -webkit-app-region: drag; user-select: none; overflow: hidden; }
  header.mac { padding-left: 78px; }
  nav { display: flex; gap: 2px; flex: none; }
  nav button { all: unset; width: 26px; height: 24px; display: grid; place-content: center; border-radius: 5px; color: var(--texte-doux); -webkit-app-region: no-drag; }
  nav button:hover:not(:disabled) { background: var(--fond-survol); color: var(--texte); }
  nav button:disabled { opacity: 0.4; }
  nav button[aria-pressed="true"] { background: var(--fond-actif); color: var(--texte); }
  .titre { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nom { font-weight: 600; color: var(--texte); }
  .domaine { color: var(--texte-doux); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
  .chercher { all: unset; flex: none; padding: 3px 8px; border-radius: 5px; font-size: 12px; color: var(--texte-doux); white-space: nowrap; -webkit-app-region: no-drag; }
  .chercher:disabled { opacity: 0.5; }
  .chercher:hover:not(:disabled) { background: var(--fond-survol); color: var(--texte); }
  .avis { display: flex; align-items: center; gap: 8px; flex: none; max-width: 60%; padding: 3px 4px 3px 10px; border-radius: 6px; background: var(--attention-fond); color: var(--texte); font-size: 12px; -webkit-app-region: no-drag; }
  /* A transient mention (info): without an alert background. */
  .avis[data-genre="info"] { background: none; color: var(--texte-doux); }
  .avis span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .avis button { all: unset; padding: 2px 8px; border-radius: 5px; background: var(--fond-actif); color: var(--texte); white-space: nowrap; -webkit-app-region: no-drag; }
  .avis button:hover { background: var(--fond-survol); }
  .extensions { display: flex; align-items: center; gap: 2px; flex: none; -webkit-app-region: no-drag; }
</style>
