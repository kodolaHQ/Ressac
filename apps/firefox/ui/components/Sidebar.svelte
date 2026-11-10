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

<aside class="bar" data-testid="sidebar" hidden={hidden}>
  <UrlBar window={win} />
  <div class="scrolling">
    <Essentials window={win} />
    <ul
      class="pinned"
      data-testid="pinned"
      ondragover={(e) => e.dataTransfer?.types.includes("application/x-webaios-onglet") && e.preventDefault()}
      ondrop={(e) => {
        const id = e.dataTransfer?.getData("application/x-webaios-onglet");
        if (id) api.dispatch({ type: "pinTab", id });
      }}
    >
      {#each space?.pinned ?? [] as favorite (favorite.id)}
        <li>
          <button
            data-testid="favorite-{favorite.id}"
            class:active={favorite.id === activeLink}
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
    <div class="space" data-testid="space-title">{space?.icon} {space?.name}</div>
    <TabList window={win} />
    <button class="new" data-testid="new-tab" onclick={() => api.dispatch({ type: "showBlankPage", windowId: win.id })}><Icon name="plus" size={14} /> Nouvel onglet</button>
  </div>
  <footer>
    <SpaceSelector window={win} />
    <button
      class="tool"
      data-testid="agent-button"
      aria-label="Agent (⌘J)"
      title="Agent (⌘J)"
      aria-pressed={!builder && win.agentPanelOpen}
      onclick={() => (builder ? builderAgent?.() : api.dispatch({ type: "toggleAgentPanel", windowId: win.id }))}><Icon name="agent" /></button
    >
    <button
      class="tool"
      data-testid="applications-button"
      aria-label="Applications (⇧⌘A)"
      title="Applications (⇧⌘A)"
      aria-pressed={activeTab?.url === URL_APPLICATIONS}
      onclick={() => api.dispatch({ type: "openApps", windowId: win.id })}><Icon name="apps" /></button
    >
    <button
      class="tool"
      data-testid="actions-button"
      aria-label="Actions"
      title="Actions"
      aria-pressed={activeTab?.url === URL_ACTIONS}
      onclick={() => api.dispatch({ type: "openActions", windowId: win.id })}><Icon name="actions" /></button
    >
    {#if downloads.list.length}
      <button class="downloads" aria-label="Téléchargements" title="Téléchargements" onclick={() => togglePanel?.("downloads")}>
        <Icon name="download" />
        {#if running.length}<span class="pill" style:--p={progression}></span>{/if}
      </button>
    {/if}
  </footer>
</aside>

<style>
  .bar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 10px 8px 0;
    background: var(--bg-bar);
    -webkit-app-region: drag;
  }
  .bar[hidden] { display: none; }
  .scrolling { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin-top: 14px; -webkit-app-region: no-drag; }
  .bar :global(nav) { -webkit-app-region: no-drag; }
  .pinned { list-style: none; margin: 0; padding: 0; min-height: 8px; }
  .pinned button { all: unset; display: flex; align-items: center; gap: 8px; width: calc(100% - 16px); height: 34px; padding: 0 8px; border-radius: 8px; color: var(--text); }
  .pinned button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pinned button:hover { background: var(--bg-hover); }
  .pinned button.active { background: var(--bg-active); }
  footer { display: flex; align-items: flex-end; gap: 4px; -webkit-app-region: no-drag; }
  footer :global(nav) { flex: 1; }
  .downloads { all: unset; position: relative; width: 28px; height: 28px; margin-bottom: 8px; display: grid; place-content: center; border-radius: 6px; color: var(--text-muted); }
  .downloads:hover { background: var(--bg-hover); }
  .tool { all: unset; -webkit-app-region: no-drag; width: 28px; height: 28px; margin-bottom: 8px; display: grid; place-content: center; border-radius: 6px; color: var(--text-muted); }
  .tool:hover { background: var(--bg-hover); }
  .tool[aria-pressed="true"] { color: var(--accent); }
  .pill { position: absolute; inset: 3px; border-radius: 50%; background: conic-gradient(var(--accent) calc(var(--p) * 360deg), transparent 0); mask: radial-gradient(circle, transparent 55%, black 56%); }
  .space { padding: 10px 8px 0; font-size: 12px; font-weight: 600; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; }
  .new { all: unset; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 8px; border-radius: 8px; color: var(--text-muted); }
  .new:hover { background: var(--bg-hover); }
</style>
