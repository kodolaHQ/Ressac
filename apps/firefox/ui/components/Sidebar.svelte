<script lang="ts">
  import type { Panel } from "../../shared/api";
  import { URL_ACTIONS, URL_APPLICATIONS, URL_SETTINGS, workflowUrlTarget, type WindowState } from "../../shared/model";
  import { shortcutLabel, type ShortcutId } from "../../shared/shortcuts";
  import { api, appState, downloads } from "../state.svelte";
  import UrlBar from "./UrlBar.svelte";
  import Essentials from "./Essentials.svelte";
  import Icon from "./Icon.svelte";
  import Pinned from "./Pinned.svelte";
  import TabList from "./TabList.svelte";
  import { openMenu } from "./menu.svelte";
  import CallBar from "./CallBar.svelte";
  import UpdateCard from "./UpdateCard.svelte";
  import SpaceSelector from "./SpaceSelector.svelte";
  import { createSwipe } from "./swipe";
  import { toNextSpace } from "../../core/shortcuts";

  const key = (id: ShortcutId) => shortcutLabel(id, appState.value?.settings);

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
  // Two fingers across the sidebar: the neighbouring space (the page keeps the gesture for back / forward).
  const swipe = createSwipe((delta) => {
    const action = appState.value && toNextSpace(appState.value, win.id, delta, false);
    if (action) api.dispatch(action);
  });
  // Not passive (Svelte's onwheel is): a horizontal move left unhandled lets Firefox track it as its own back / forward
  // swipe, which then swallows the next gestures over the sidebar.
  const swipeArea = (node: HTMLElement) => {
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.preventDefault();
      swipe(e);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return { destroy: () => node.removeEventListener("wheel", onWheel) };
  };
  // A space change slides the list in from the side it comes from, with the spring (a short fade under reduced motion).
  let list = $state<HTMLElement>();
  let shownSpace: string | undefined;
  $effect(() => {
    const id = win.activeSpace;
    const spaces = appState.value?.spaces ?? [];
    const from = spaces.findIndex((e) => e.id === shownSpace);
    shownSpace = id;
    if (!list || from < 0 || id === spaces[from]?.id) return;
    const side = spaces.findIndex((e) => e.id === id) > from ? 1 : -1;
    const css = getComputedStyle(list);
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.animate(
      [{ opacity: 0, transform: still ? "none" : `translateX(${side * 28}px)` }, { opacity: 1, transform: "none" }],
      { duration: parseFloat(css.getPropertyValue("--spring-d")) || 460, easing: still ? "ease-out" : css.getPropertyValue("--spring") || "ease-out" },
    );
  });
  const running = $derived(downloads.list.filter((t) => t.state === "in-progress"));
  const progression = $derived.by(() => {
    const total = running.reduce((s, t) => s + t.total, 0);
    return total ? running.reduce((s, t) => s + t.received, 0) / total : 0;
  });
  const space = $derived(appState.value?.spaces.find((e) => e.id === win.activeSpace));
  // Past two spaces the tools fold behind one button so the spaces keep the whole row.
  const foldable = $derived((appState.value?.spaces.length ?? 0) > 2);
  let pinned = $state<Pinned>();
  let toolsOpen = $state(false);
  let fold = $state<HTMLElement>();
  const activeTab = $derived.by(() => {
    const id = win.active[win.activeSpace];
    return id ? appState.value?.tabs[id] : undefined;
  });
  const activeLink = $derived(activeTab?.link?.id);
  // In the builder, the agent has its « Agent » tab: ✦ shows it there (like ⌘J), the side panel does not appear.
  const builder = $derived(!!activeTab && workflowUrlTarget(activeTab.url) !== null);
</script>

<svelte:window
  onclick={(e) => toolsOpen && !fold?.contains(e.target as Node) && (toolsOpen = false)}
  onkeydown={(e) => toolsOpen && e.key === "Escape" && (toolsOpen = false)}
  onblur={() => (toolsOpen = false)}
/>

<aside class="bar" data-testid="sidebar" hidden={hidden} use:swipeArea>
  <UrlBar window={win} />
  <!-- An essential dragged out of its grid and dropped anywhere below is no longer one: its open tab joins the list. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="scrolling"
    bind:this={list}
    ondragover={(e) => e.dataTransfer?.types.includes("application/x-ressac-essentiel") && e.preventDefault()}
    ondrop={(e) => {
      const favoriteId = e.dataTransfer?.getData("application/x-ressac-essentiel");
      if (favoriteId) api.dispatch({ type: "removeEssential", favoriteId });
    }}
  >
    <Essentials window={win} />
    {#if space}<Pinned bind:this={pinned} window={win} {space} {activeLink} />{/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="space" data-testid="space-title" oncontextmenu={(e) => openMenu(e, [{ label: "Nouveau dossier", dispatch: () => pinned?.newFolder() }])}>{space?.icon} {space?.name}</div>
    <TabList window={win} />
    <button class="new" data-testid="new-tab" onclick={() => api.dispatch({ type: "showBlankPage", windowId: win.id })}
      ><Icon name="plus" size={14} /> Nouvel onglet<kbd>{key("command")}</kbd></button
    >
    <TabList window={win} agent />
  </div>
  <UpdateCard />
  <CallBar window={win} />
  <footer>
    <SpaceSelector window={win} />
    {#snippet tools()}
    <button
      class="tool"
      style:--i={0}
      data-testid="agent-button"
      aria-label="Agent ({key("agent")})"
      title="Agent ({key("agent")})"
      aria-pressed={!builder && win.agentPanelOpen}
      onclick={() => (builder ? builderAgent?.() : api.dispatch({ type: "toggleAgentPanel", windowId: win.id }))}><Icon name="agent" /></button
    >
    <button
      class="tool"
      style:--i={1}
      data-testid="applications-button"
      aria-label="Applications ({key("apps")})"
      title="Applications ({key("apps")})"
      aria-pressed={activeTab?.url === URL_APPLICATIONS}
      onclick={() => api.dispatch({ type: "openApps", windowId: win.id })}><Icon name="apps" /></button
    >
    <button
      class="tool"
      style:--i={2}
      data-testid="actions-button"
      aria-label="Actions"
      title="Actions"
      aria-pressed={activeTab?.url === URL_ACTIONS}
      onclick={() => api.dispatch({ type: "openActions", windowId: win.id })}><Icon name="actions" /></button
    >
    <button
      class="tool"
      style:--i={3}
      data-testid="settings-button"
      aria-label="Réglages ({key("settings")})"
      title="Réglages ({key("settings")})"
      aria-pressed={activeTab?.url === URL_SETTINGS}
      onclick={() => api.dispatch({ type: "openSettings", windowId: win.id })}><Icon name="settings" /></button
    >
    {/snippet}
    {#if foldable}
      <!-- Past two spaces the tools fold into ⋯, which opens them upward. -->
      <div class="fold" bind:this={fold}>
        {#if toolsOpen}
          <div class="pop" data-testid="tools-pop" onclick={() => (toolsOpen = false)} role="presentation">{@render tools()}</div>
        {/if}
        <button
          class="tool"
          data-testid="tools-button"
          aria-label="Outils"
          title="Outils"
          aria-expanded={toolsOpen}
          class:on={toolsOpen || win.agentPanelOpen || [URL_APPLICATIONS, URL_ACTIONS, URL_SETTINGS].includes(activeTab?.url ?? "")}
          onclick={() => (toolsOpen = !toolsOpen)}><Icon name="options" /></button
        >
      </div>
    {:else}
      {@render tools()}
    {/if}
    {#if downloads.list.length}
      <button class="downloads" aria-label="Téléchargements" title="Téléchargements" onclick={() => togglePanel?.("downloads")}>
        <Icon name="download" />
        {#if running.length}<span class="pill" style:--p={progression}></span>{/if}
      </button>
    {/if}
  </footer>
</aside>

<style>
  /* A glass pane floating on the aura, 8 px from the window's edges and from the page (the same frame as the page). */
  .bar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    margin: 8px;
    padding: 2px 6px 0;
    border: 1px solid var(--glass-edge);
    border-radius: 16px;
    background: var(--glass);
    box-shadow: var(--lift);
    -webkit-app-region: drag;
  }
  .bar[hidden] { display: none; }
  .scrolling { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin-top: 14px; -webkit-app-region: no-drag; }
  .bar :global(nav) { -webkit-app-region: no-drag; }
  .new:active, .tool:active, .downloads:active { transform: scale(0.97); }
  /* One row: the spaces take what the tools leave and scroll past it; a space deletion confirmation gets the full width. */
  footer { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 2px; margin: 0 -6px; padding: 6px 6px 8px; border-top: 1px solid var(--border); -webkit-app-region: no-drag; }
  footer :global(nav) { flex: 1 1 0; min-width: 0; }
  footer :global(nav:has(.confirmation)) { flex-basis: 100%; }
  .tool:first-of-type { margin-left: auto; }
  .fold { position: relative; margin-left: auto; }
  /* The tools rise from ⋯ on the spring, one after the other. */
  .pop { position: absolute; right: -4px; bottom: calc(100% + 6px); display: flex; flex-direction: column; gap: 2px; padding: 4px; background: var(--glass-dense); backdrop-filter: blur(30px) saturate(1.8); border: 1px solid var(--glass-edge); border-radius: 12px; box-shadow: var(--modal-shadow); transform-origin: bottom right; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .pop .tool { margin: 0; animation: ressac-rise var(--spring-d) var(--spring) backwards; animation-delay: calc((3 - var(--i)) * 35ms); }
  .downloads { all: unset; position: relative; width: 28px; height: 28px; display: grid; place-content: center; border-radius: 8px; color: var(--text-muted); transition: transform var(--tap), background var(--tap), color var(--tap); }
  .tool { all: unset; -webkit-app-region: no-drag; width: 28px; height: 28px; display: grid; place-content: center; border-radius: 8px; color: var(--text-muted); transition: transform var(--tap), background var(--tap), color var(--tap); }
  .tool:hover, .downloads:hover { background: var(--glass-hi); color: var(--text); }
  .tool[aria-pressed="true"], .tool.on { color: var(--accent); background: var(--glass-hi); }
  .pill { position: absolute; inset: 3px; border-radius: 50%; background: conic-gradient(var(--accent) calc(var(--p) * 360deg), transparent 0); mask: radial-gradient(circle, transparent 55%, currentColor 56%); }
  .space { padding: 10px 10px 2px; font: 600 13px/1.2 var(--font-display); letter-spacing: -0.01em; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; }
  .new { all: unset; display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 10px; border-radius: 10px; color: var(--text-muted); transition: transform var(--tap), background var(--tap), color var(--tap); }
  .new kbd { margin-left: auto; opacity: 0; transition: opacity var(--tap); }
  .new:hover { background: color-mix(in srgb, var(--glass-hi) 55%, transparent); color: var(--text); }
  .new:hover kbd { opacity: 1; }
</style>
