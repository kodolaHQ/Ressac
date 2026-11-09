<script lang="ts">
  import type { Panel } from "../../shared/api";
  import { URL_ACTIONS, URL_APPLICATIONS, workflowUrlTarget, type WindowState } from "../../shared/model";
  import { api, appState, downloads } from "../state.svelte";
  import UrlBar from "./UrlBar.svelte";
  import Essentials from "./Essentials.svelte";
  import Icon from "./Icon.svelte";
  import SiteIcon from "./SiteIcon.svelte";
  import TabList from "./TabList.svelte";
  import { openMenu } from "./menu.svelte";
  import SpaceSelector from "./SpaceSelector.svelte";

  let {
    window: win,
    hidden: hidden = false,
    togglePanel: togglePanel,
    builderAgent: builderAgent,
  }: {
    window: WindowState;
    hidden?: boolean;
    togglePanel?: (p: Panel) => void;
    /** ✦ on a builder tab: its « Agent » tab (instead of the side panel). */
    builderAgent?: () => void;
  } = $props();
  const running = $derived(downloads.list.filter((t) => t.state === "in-progress"));
  const progression = $derived.by(() => {
    const total = running.reduce((s, t) => s + t.total, 0);
    return total ? running.reduce((s, t) => s + t.received, 0) / total : 0;
  });
  const space = $derived(appState.value?.spaces.find((e) => e.id === win.activeSpace));
  const activeTab = $derived.by(() => {
    const id = win.active[win.activeSpace];
    return id ? appState.value?.tabs[id] : undefined;
  });
  const activeLink = $derived(activeTab?.link?.id);
  // In the builder, the agent has its « Agent » tab: ✦ shows it there (like ⌘J), the side panel does not appear.
  const builder = $derived(!!activeTab && workflowUrlTarget(activeTab.url) !== null);
</script>

<aside class="barre" data-testid="barre-laterale" hidden={hidden}>
  <UrlBar window={win} />
  <div class="defilant">
    <Essentials window={win} />
    <ul
      class="epingles"
      data-testid="epingles"
      ondragover={(e) => e.dataTransfer?.types.includes("application/x-webaios-onglet") && e.preventDefault()}
      ondrop={(e) => {
        const id = e.dataTransfer?.getData("application/x-webaios-onglet");
        if (id) api.dispatch({ type: "pinTab", id });
      }}
    >
      {#each space?.pinned ?? [] as favorite (favorite.id)}
        <li>
          <button
            data-testid="favori-{favorite.id}"
            class:actif={favorite.id === activeLink}
            onclick={() => api.dispatch({ type: "openFavorite", windowId: win.id, kind: "pinned", id: favorite.id })}
            oncontextmenu={(e) =>
              openMenu(e, [{ label: "Retirer", dispatch: () => api.dispatch({ type: "unpin", spaceId: win.activeSpace, favoriteId: favorite.id }) }])}
          >
            <SiteIcon favicon={favorite.favicon} title={favorite.title} />
            <span>{favorite.title}</span>
          </button>
        </li>
      {/each}
    </ul>
    <div class="espace" data-testid="titre-espace">{space?.icon} {space?.name}</div>
    <TabList window={win} />
    <button class="nouveau" data-testid="nouvel-onglet" onclick={() => api.dispatch({ type: "showBlankPage", windowId: win.id })}><Icon name="plus" size={14} /> Nouvel onglet</button>
  </div>
  <footer>
    <SpaceSelector window={win} />
    <button
      class="outil"
      data-testid="bouton-agent"
      aria-label="Agent (⌘J)"
      title="Agent (⌘J)"
      aria-pressed={!builder && win.agentPanelOpen}
      onclick={() => (builder ? builderAgent?.() : api.dispatch({ type: "toggleAgentPanel", windowId: win.id }))}><Icon name="agent" /></button
    >
    <button
      class="outil"
      data-testid="bouton-applications"
      aria-label="Applications (⇧⌘A)"
      title="Applications (⇧⌘A)"
      aria-pressed={activeTab?.url === URL_APPLICATIONS}
      onclick={() => api.dispatch({ type: "openApps", windowId: win.id })}><Icon name="apps" /></button
    >
    <button
      class="outil"
      data-testid="bouton-actions"
      aria-label="Actions"
      title="Actions"
      aria-pressed={activeTab?.url === URL_ACTIONS}
      onclick={() => api.dispatch({ type: "openActions", windowId: win.id })}><Icon name="actions" /></button
    >
    {#if downloads.list.length}
      <button class="telechargements" aria-label="Téléchargements" title="Téléchargements" onclick={() => togglePanel?.("downloads")}>
        <Icon name="download" />
        {#if running.length}<span class="pastille" style:--p={progression}></span>{/if}
      </button>
    {/if}
  </footer>
</aside>

<style>
  .barre {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 10px 8px 0;
    background: var(--fond-barre);
    -webkit-app-region: drag;
  }
  .barre[hidden] { display: none; }
  .defilant { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin-top: 14px; -webkit-app-region: no-drag; }
  .barre :global(nav) { -webkit-app-region: no-drag; }
  .epingles { list-style: none; margin: 0; padding: 0; min-height: 8px; }
  .epingles button { all: unset; display: flex; align-items: center; gap: 8px; width: calc(100% - 16px); height: 34px; padding: 0 8px; border-radius: 8px; color: var(--texte); }
  .epingles button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .epingles button:hover { background: var(--fond-survol); }
  .epingles button.actif { background: var(--fond-actif); }
  footer { display: flex; align-items: flex-end; gap: 4px; -webkit-app-region: no-drag; }
  footer :global(nav) { flex: 1; }
  .telechargements { all: unset; position: relative; width: 28px; height: 28px; margin-bottom: 8px; display: grid; place-content: center; border-radius: 6px; color: var(--texte-doux); }
  .telechargements:hover { background: var(--fond-survol); }
  .outil { all: unset; -webkit-app-region: no-drag; width: 28px; height: 28px; margin-bottom: 8px; display: grid; place-content: center; border-radius: 6px; color: var(--texte-doux); }
  .outil:hover { background: var(--fond-survol); }
  .outil[aria-pressed="true"] { color: var(--accent); }
  .pastille { position: absolute; inset: 3px; border-radius: 50%; background: conic-gradient(var(--accent) calc(var(--p) * 360deg), transparent 0); mask: radial-gradient(circle, transparent 55%, black 56%); }
  .espace { padding: 10px 8px 0; font-size: 12px; font-weight: 600; color: var(--texte-doux); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; }
  .nouveau { all: unset; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 8px; border-radius: 8px; color: var(--texte-doux); }
  .nouveau:hover { background: var(--fond-survol); }
</style>
