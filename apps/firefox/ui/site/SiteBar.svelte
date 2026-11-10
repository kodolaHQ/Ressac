<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import SiteDesignButton from "./SiteDesignButton.svelte";
  import SiteExtensionsButtons from "../SiteAddonsStrip.svelte";
  import { SITE_BAR_HEIGHT, SEARCH_URL, blockedLink, OPEN_IN_A_TAB, type SiteWindowState } from "../../shared/sites";
  import type { ApiSite } from "../../shared/api";

  let { state: appState, api }: { state: SiteWindowState; api: ApiSite } = $props();
  /** macOS: the window buttons are in the bar, on the left. */
  const mac = navigator.userAgent.includes("Mac");
  const onSite = $derived(appState.viewState === "site");
  /** The design mode chevron unfolds its entries in place of the title. */
  let menuDesign = $state(false);
</script>

<!-- The background is draggable (moves the window); each button and the mention are clickable (no-drag). -->
<header data-testid="site-bar" class:mac style:height="{SITE_BAR_HEIGHT}px">
  <nav>
    <button data-testid="site-back" aria-label="Reculer" disabled={!onSite || !appState.canGoBack} onclick={() => api.previous()}><Icon name="back" /></button>
    <button data-testid="site-forward" aria-label="Avancer" disabled={!onSite || !appState.canGoForward} onclick={() => api.next()}><Icon name="forward" /></button>
    {#if appState.hasHome}
      <button data-testid="site-home" aria-label="Accueil de l'appli" aria-pressed={appState.viewState === "home"} disabled={appState.viewState === "grant"} onclick={() => api.home()}><Icon name="home" /></button>
    {/if}
    <button data-testid="site-reload" aria-label="Recharger" disabled={!onSite} onclick={() => api.reload()}><Icon name="reload" /></button>
  </nav>
  <div class="title">
    {#if !menuDesign}
      <span data-testid="site-name" class="name">{appState.name}</span>
      <span data-testid="site-domain" class="domain">{appState.domain}</span>
    {/if}
  </div>
  {#if appState.tracking && onSite}
    <button data-testid="site-search-address" class="search" disabled={appState.search} aria-busy={appState.search} onclick={() => api.lookupAddress()}>{SEARCH_URL}</button>
  {/if}
  {#if appState.notice}
    <div data-testid="site-notice" class="notice" data-kind={appState.notice.kind} role="status">
      {#if appState.notice.kind === "link-blocked"}
        <span>{blockedLink(appState.notice.domain)}</span>
        <button data-testid="site-open-tab" onclick={() => api.openBlocked()}>{OPEN_IN_A_TAB}</button>
      {:else}
        <span>{appState.notice.text}</span>
      {/if}
    </div>
  {/if}
  <!-- Right: the design mode (every view), then the active add-ons' buttons (« site » view only). -->
  <div class="extensions">
    <SiteDesignButton {api} state={appState} bind:menuOpen={menuDesign} />
    <SiteExtensionsButtons {api} onSite={onSite} />
  </div>
</header>

<style>
  header { display: flex; align-items: center; gap: 10px; padding: 0 8px; box-sizing: border-box; background: var(--bg-bar); border-bottom: 1px solid var(--border); -webkit-app-region: drag; user-select: none; overflow: hidden; }
  header.mac { padding-left: 78px; }
  nav { display: flex; gap: 2px; flex: none; }
  nav button { all: unset; width: 26px; height: 24px; display: grid; place-content: center; border-radius: 5px; color: var(--text-muted); -webkit-app-region: no-drag; }
  nav button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
  nav button:disabled { opacity: 0.4; }
  nav button[aria-pressed="true"] { background: var(--bg-active); color: var(--text); }
  .title { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .name { font-weight: 600; color: var(--text); }
  .domain { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
  .search { all: unset; flex: none; padding: 3px 8px; border-radius: 5px; font-size: 12px; color: var(--text-muted); white-space: nowrap; -webkit-app-region: no-drag; }
  .search:disabled { opacity: 0.5; }
  .search:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
  .notice { display: flex; align-items: center; gap: 8px; flex: none; max-width: 60%; padding: 3px 4px 3px 10px; border-radius: 6px; background: var(--attention-bg); color: var(--text); font-size: 12px; -webkit-app-region: no-drag; }
  /* A transient mention (info): without an alert background. */
  .notice[data-kind="info"] { background: none; color: var(--text-muted); }
  .notice span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notice button { all: unset; padding: 2px 8px; border-radius: 5px; background: var(--bg-active); color: var(--text); white-space: nowrap; -webkit-app-region: no-drag; }
  .notice button:hover { background: var(--bg-hover); }
  .extensions { display: flex; align-items: center; gap: 2px; flex: none; -webkit-app-region: no-drag; }
</style>
