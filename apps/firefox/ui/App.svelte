<script lang="ts">
  // The window's UI: sidebar, spaces, empty page, command bar. Web pages are Firefox's <browser>, under
  // this transparent iframe; the iframe covers the whole window only when the UI shows more than its column.
  import { tick, untrack } from "svelte";
  import PageAction from "../ui/action/PageAction.svelte";
  import Actions from "./components/Actions.svelte";
  import Applications from "./components/Applications.svelte";
  import CommandBar from "./components/CommandBar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Extensions from "./components/Extensions.svelte";
  import FrozenBackground from "./components/FrozenBackground.svelte";
  import History from "./components/History.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";
  import RequestModal from "./components/RequestModal.svelte";
  import SpaceModal from "./components/SpaceModal.svelte";
  import EmptyPage from "./components/EmptyPage.svelte";
  import Downloads from "./components/Downloads.svelte";
  import TabsPanel from "./components/TabsPanel.svelte";
  import Review from "./components/Review.svelte";
  import Settings from "./components/Settings.svelte";
  import { focusAgent } from "./components/agent.svelte";
  import { design, rereadDesign } from "./components/design.svelte";
  import { command, closeCommand, focusEmptyPage, openCommand } from "./components/command.svelte";
  import { isAgentRequest } from "./components/modal.svelte";
  import { menu } from "./components/menu.svelte";
  import { spaceSettings } from "./components/spaceSettings.svelte";
  import { access, api, requestOf, appState, currentWindow, closeTab } from "./state.svelte";
  import { actionOfUrl, hasView, workflowUrlTarget, reviewUrlProject, URL_ACTIONS, URL_APPLICATIONS, URL_EXTENSIONS, URL_SETTINGS } from "../shared/model";
  import { ACTIONS_IN_PRIVATE_SPACE } from "../shared/actions";
  import { hide, INITIAL_REVEAL, onZone, type LeftZone } from "../shared/reveal";
  import type { Panel, TabsPanel as TabPanel } from "../shared/api";
  import type { ApiFirefox } from "./api";
  import InternalPage from "./InternalPage.svelte";
  import PageError from "./PageError.svelte";
  import WorkflowBuilder from "./WorkflowBuilder.svelte";

  const HIDING_MS = 300;

  const win = window.parent.webaiosWindow!;

  const winState = $derived(currentWindow());
  const activeTab = $derived.by(() => {
    const id = winState?.active[winState.activeSpace];
    return id ? appState.value?.tabs[id] : undefined;
  });
  // A crashed or failed page shows our message instead (the window parks its <browser>).
  const pageWeb = $derived(!!activeTab && hasView(activeTab.url) && !activeTab.crashed && !activeTab.error);
  /** The history or downloads panel over the content area (⌘Y, ⇧⌘J, the sidebar's button); another tab closes it. */
  let panel = $state<Panel | null>(null);
  const closePanel = () => {
    panel = null;
    api.returnFocusToPage();
  };
  const togglePanel = (p: Panel) => (panel === p ? closePanel() : (panel = p));
  /** A widget's or an action's workflow builder is the active tab. */
  const builderTarget = $derived(activeTab ? workflowUrlTarget(activeTab.url) : null);
  // An action's page launches nothing when opened. Refused when the tab's space (or the one shown)
  // is private; a space not found counts as private.
  const pageAction = $derived(activeTab ? actionOfUrl(activeTab.url) : null);
  const reviewProject = $derived(activeTab ? reviewUrlProject(activeTab.url) : null);
  const privateAction = $derived.by(() => {
    const spaces = appState.value?.spaces ?? [];
    const isPrivate = (id: string | undefined) => spaces.find((e) => e.id === id)?.private ?? true;
    return isPrivate(winState?.activeSpace) || isPrivate(activeTab?.spaceId);
  });
  /**
   * ⌘J or ✦ on a builder tab: its Agent tab. A UI panel over it closes first; the
   * request waits for the builder to mount again, so that it sees it.
   */
  function builderAgent(): void {
    if (panel === null) return void focusAgent.n++;
    panel = null;
    void tick().then(() => focusAgent.n++);
  }
  $effect(() => api.onPanel(togglePanel));
  // ZoneContenu's design mode: it follows the tab shown and its address (the chrome stops the mode if it changes).
  $effect(() => {
    void activeTab?.id;
    void activeTab?.url;
    void rereadDesign();
  });
  /** The cart column: while the design mode is on, or asked by « Panier ». */
  const designBasket = $derived.by(() => {
    const e = design.state;
    return e?.project && panel === null && (e.active || design.basketRequested) ? e : null;
  });
  const firefox = api as unknown as ApiFirefox;
  // The column is a chrome frame beside the page: opened again on another project, so that it shows that one's cart.
  // A string, not the state object (new at each read): the column opens once per project, never at each read.
  const drawerProject = $derived(designBasket?.project?.project ?? null);
  $effect(() => firefox.designPanel(drawerProject !== null));
  $effect(() =>
    firefox.onPanelClosed(() => {
      design.basketRequested = false;
      if (design.state?.active) api.design.toggle();
    }),
  );
  // The command bar targets the tab active when it opened: if another one shows, it closes.
  const activeId = $derived(activeTab?.id);
  $effect(() => {
    void activeId;
    untrack(() => {
      command.open = null;
      panel = null;
    });
  });
  // An agent's question covers the whole window, agent panel included. It comes before an open command bar, which closes.
  const request = $derived(requestOf(winState, activeTab));
  const agentRequest = $derived(request && isAgentRequest(request) ? request : undefined);
  const agentRequestId = $derived(agentRequest?.id);
  $effect(() => {
    if (agentRequestId !== undefined) untrack(() => closeCommand());
  });
  // Before the card mounts and takes the keyboard: the terminal or the page gets it back once the last card goes.
  const agentCard = $derived(agentRequestId !== undefined);
  $effect.pre(() => {
    if (!agentCard) return;
    const giveBack = untrack(() => win.rememberFocus());
    return () => setTimeout(giveBack);
  });
  /** The ⌃Tab panel sent by the controller (null: closed). */
  let tabPanel = $state<TabPanel | null>(null);
  // Ready: the backdrop is in place (no page capture in step 2, it is ready at once).
  let tabPanelReady = $state(false);
  $effect(() =>
    api.onTabsPanel((p) => {
      tabPanel = p;
      if (!p) tabPanelReady = false;
    }),
  );
  $effect(() =>
    api.onShortcut((r) => {
      if (r === "closeTab") {
        if (activeTab) closeTab(activeTab.id);
      } else if (r === "command") openCommand("new");
      else if (r === "address") {
        if (activeTab) openCommand("active", activeTab.url);
        else openCommand("new");
      } else if (r === "agent" && builderTarget) builderAgent();
    }),
  );
  // Overlays cover the agent panel too; the empty page and internal pages only fill the space left of it.
  const overlay = $derived(!!agentRequest || !!spaceSettings.draft || !!menu.open || !!command.open || !!tabPanel);
  $effect(() => win.setFullWindow(overlay ? "window" : !pageWeb || !!panel));

  // Compact mode: touching the left edge reveals the sidebar. It floats over the page, which
  // keeps its size: resizing a page on every frame of the slide would not be smooth.
  // The controller reports the mouse everywhere in the window; the decision is in reveal.ts.
  const compact = $derived(winState?.compact ?? false);
  let revealed = $state(false);
  let armed = INITIAL_REVEAL.armed;
  let zone: LeftZone = "far";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const barVisible = $derived(!compact || revealed);

  function onMouseZone(z: LeftZone) {
    zone = z;
    if (!compact) return;
    const r = onZone({ revealed: revealed, armed: armed }, z);
    armed = r.armed;
    revealed = r.revealed;
    if (r.hide) scheduleHide();
    else clearTimeout(timer);
  }
  function scheduleHide() {
    clearTimeout(timer);
    // The access bubble is mounted outside the sidebar: while it is open, the sidebar stays.
    if (!revealed || access.openBubbles > 0) return;
    timer = setTimeout(() => {
      if (zone !== "far" || access.openBubbles > 0) return;
      const r = hide(zone);
      revealed = r.revealed;
      armed = r.armed;
    }, HIDING_MS);
  }
  // Once the bubble closes, hiding resumes if the mouse is already away from the sidebar.
  $effect(() => {
    if (access.openBubbles === 0) untrack(() => zone === "far" && scheduleHide());
  });
  $effect(() => api.onLeftZone(onMouseZone));
  $effect(() => win.setSidebarColumn(!compact));
  $effect(() => win.setSidebarVisible(barVisible));
  $effect(() => {
    if (!compact) {
      clearTimeout(timer);
      revealed = false;
    }
  });
</script>

<!-- A tab switch to the parking tab blurs the field the empty page had just focused; the controller then focuses this
     iframe again (TabSwitchDone), and the empty page takes the keyboard back. -->
<svelte:window onfocus={() => document.activeElement === document.body && focusEmptyPage.n++} />

<div class="window" inert={!!agentRequest || !!spaceSettings.draft || !!command.open} class:compact class:covered={overlay}>
  <div class="column" class:folded-up={!barVisible} inert={!barVisible}>
    {#if winState}
      <!-- ✦ on a builder tab: the controller opens the panel and sends "agent", handled above. -->
      <Sidebar window={winState} togglePanel={togglePanel} builderAgent={() => win.openAgent()} />
    {:else}
      <aside data-testid="sidebar"></aside>
    {/if}
  </div>
  <main class="content" class:opaque={!pageWeb || !!panel} data-testid="content-zone">
    {#if winState && panel === "history"}
      <History window={winState} close={closePanel} />
    {:else if panel === "downloads"}
      <Downloads close={closePanel} />
    {:else if winState && !activeTab}
      <EmptyPage window={winState} />
    {:else if activeTab && (activeTab.crashed || activeTab.error)}
      <PageError tab={activeTab} />
    {:else if activeTab?.url === URL_EXTENSIONS}
      <Extensions />
    {:else if activeTab?.url === URL_APPLICATIONS}
      <Applications />
    {:else if activeTab?.url === URL_SETTINGS}
      <Settings />
    {:else if activeTab?.url === URL_ACTIONS}
      {#if privateAction}
        <p class="crashed" data-testid="action-private-space">{ACTIONS_IN_PRIVATE_SPACE}</p>
      {:else}
        <Actions />
      {/if}
    {:else if builderTarget}
      {#if builderTarget.type === "action" && privateAction}
        <p class="crashed" data-testid="action-private-space">{ACTIONS_IN_PRIVATE_SPACE}</p>
      {:else}
        {#key `${builderTarget.type}:${builderTarget.id}`}<WorkflowBuilder target={builderTarget} />{/key}
      {/if}
    {:else if pageAction}
      {#if privateAction}
        <p class="crashed" data-testid="action-private-space">{ACTIONS_IN_PRIVATE_SPACE}</p>
      {:else}
        {#key `${pageAction.id}/${pageAction.run}`}<PageAction id={pageAction.id} run={pageAction.run} />{/key}
      {/if}
    {:else if reviewProject}
      {#key `${activeTab?.id}:${reviewProject}`}<Review project={reviewProject} tabId={activeTab?.id ?? ""} />{/key}
    {:else if activeTab && !pageWeb}
      <InternalPage />
    {/if}
  </main>
</div>
<ContextMenu />
<!-- No page capture under the modals in step 2: the web page shows through the veil. An agent's question comes before
     the space settings, which come back with their draft. -->
{#if agentRequest}
  <RequestModal request={agentRequest} tabId={null} />
{:else if spaceSettings.draft && winState}
  <SpaceModal windowId={winState.id} tabId={null} />
{/if}
{#if tabPanel}
  <div class="tabs-layer">
    <FrozenBackground tabId={activeTab?.id ?? null} onReady={() => (tabPanelReady = true)} />
    {#if tabPanelReady}<TabsPanel panel={tabPanel} />{/if}
  </div>
{/if}
{#if command.open && winState}
  <div class="command-layer">
    <FrozenBackground tabId={activeTab?.id ?? null} onReady={() => {}} />
    <CommandBar window={winState} activeTab={activeTab} yields={!!tabPanel} closePanel={() => (panel = null)} />
  </div>
{/if}

<style>
  /* Transparent so the web page under the iframe shows; the sidebar and the content area paint their own. */
  :global(html, body) { background: transparent; }
  /* Firefox's -webkit-app-region: the same areas. An overlay over the sidebar keeps its clicks. */
  .window:not(.covered) :global(.bar) { -moz-window-dragging: drag; }
  .window :global(.bar :is(.navigation button, .line, .scrolling, footer)) { -moz-window-dragging: no-drag; }
  /* The Actions page's confirmation covers the window, its drag areas too (no-drag on its veil). */
  .window :global(:is([data-testid="action-delete-veil"], [data-testid="action-delete-confirmation"])) { -moz-window-dragging: no-drag; }
  .command-layer { position: fixed; inset: 0; z-index: 100; }
  .tabs-layer { display: contents; }
  /* Under the command bar and ⌃Tab: a breath of the background over the window, slightly blurred (the glass boxes blur more). */
  :is(.command-layer, .tabs-layer) :global(div.veil) { background: color-mix(in srgb, var(--bg) 30%, transparent); backdrop-filter: blur(6px); }
  .window {
    display: grid;
    grid-template-columns: 240px 1fr;
    height: 100%;
  }
  .window.compact { grid-template-columns: 1fr; }
  .column { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; min-height: 0; }
  .compact .column {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 10;
    width: 240px;
    transition: transform 200ms var(--out);
  }
  /* Floating over the web page, which no backdrop blur of this document reaches: a solid sheet keeps it readable, a
     wash of the aura at its top keeps it of the family. */
  .compact .column :global(.bar) {
    background: linear-gradient(color-mix(in oklab, var(--a1) 14%, var(--sheet)), var(--sheet) 45%);
    box-shadow: var(--modal-shadow);
  }
  .compact .folded-up { transform: translateX(-100%); visibility: hidden; transition: transform 200ms var(--out), visibility 0s 200ms; }
  @media (prefers-reduced-motion: reduce) {
    .compact .column { transition: none; }
  }
  /* The action page fills it (position: absolute), not the window. */
  .content { position: relative; min-width: 0; min-height: 0; }
  .opaque { background: var(--bg); }
  /* The page's error and crash messages. */
  .crashed { display: grid; place-content: center; gap: 12px; height: 100%; text-align: center; color: var(--text); }
</style>
