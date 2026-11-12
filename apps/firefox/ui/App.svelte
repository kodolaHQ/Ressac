<script lang="ts">
  // The window's UI: sidebar, spaces, empty page, command bar. Web pages are Firefox's <browser>, under
  // this transparent iframe; the iframe covers the whole window only when the UI shows more than its column.
  import { tick, untrack } from "svelte";
  import { fade } from "svelte/transition";
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
  import ReleaseNotes from "./components/ReleaseNotes.svelte";
  import Welcome from "./components/Welcome.svelte";
  import { welcomeStep } from "./components/welcome-step.svelte";
  import { agentNoteShowing, firstTimePending, markSeen } from "./components/hints";
  import FirstTimeNote from "./components/FirstTimeNote.svelte";
  import { focusAgent } from "./components/agent.svelte";
  import { design, rereadDesign } from "./components/design.svelte";
  import { command, closeCommand, focusEmptyPage, openCommand } from "./components/command.svelte";
  import { isAgentRequest } from "./components/modal.svelte";
  import { menu } from "./components/menu.svelte";
  import { spaceSettings } from "./components/spaceSettings.svelte";
  import { access, api, requestOf, appState, currentWindow, closeTab } from "./state.svelte";
  import { BAR_WIDTH, BAR_WIDTH_MAX, BAR_WIDTH_MIN, actionOfUrl, hasView, workflowUrlTarget, reviewUrlProject, URL_ACTIONS, URL_APPLICATIONS, URL_EXTENSIONS, URL_RELEASE_NOTES, URL_SETTINGS } from "../shared/model";
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
  const sidebarRight = $derived(appState.value?.settings.sidebarSide === "right");
  /** The first-launch welcome covers the whole window until it is finished, unless it stepped aside for an install page. */
  const unfinished = $derived(!!winState && appState.value?.settings.onboarded === false);
  const welcome = $derived(unfinished && !welcomeStep.aside);
  $effect(() => win.setWelcome(welcome));
  /** The welcome's layer: it stays (and keeps the whole window) for its fade out once the welcome steps aside or ends. */
  let welcomeLayer = $state(false);
  const WELCOME_FADE_MS = 150;
  $effect(() => {
    if (welcome) return void (welcomeLayer = true);
    const t = setTimeout(() => (welcomeLayer = false), WELCOME_FADE_MS);
    return () => clearTimeout(t);
  });
  // Finished (here or in another window), once its layer is gone: a later « Revoir l'accueil » starts at the beginning.
  $effect(() => {
    if (!unfinished && !welcomeLayer) untrack(() => Object.assign(welcomeStep, { page: 1, aside: false }));
  });
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
      if (p) markSeen("ctrl-tab");
      else tabPanelReady = false;
    }),
  );
  $effect(() =>
    api.onShortcut((r) => {
      if (r === "closeTab") {
        if (activeTab) closeTab(activeTab.id);
      } else if (r === "command") {
        markSeen("cmd-t");
        openCommand("new");
      } else if (r === "address") {
        markSeen("cmd-l");
        if (activeTab) openCommand("active", activeTab.url);
        else openCommand("new");
      } else if (r === "agent") {
        markSeen("cmd-j");
        if (builderTarget) builderAgent();
      }
    }),
  );
  // Overlays cover the agent panel too; the empty page and internal pages only fill the space left of it.
  const modalOpen = $derived(welcomeLayer || !!agentRequest || !!spaceSettings.draft || !!menu.open || !!command.open || !!tabPanel);
  // The one-time notes of design mode (over the page: a frozen background, the whole window) and of the Actions page; never over another modal.
  const designNoteDue = $derived(!modalOpen && !agentNoteShowing() && !!design.state?.active && firstTimePending("design"));
  /** The note's layer stays (and keeps the whole window) for the note's fade out. */
  let designNote = $state(false);
  $effect(() => {
    if (designNoteDue) return void (designNote = true);
    const t = setTimeout(() => (designNote = false), WELCOME_FADE_MS);
    return () => clearTimeout(t);
  });
  const overlay = $derived(modalOpen || designNote);
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

  /** The sidebar's width while its inner edge is dragged; the state holds it otherwise. */
  let dragged = $state<number | null>(null);
  const barWidth = $derived(dragged ?? appState.value?.settings.sidebarWidth ?? BAR_WIDTH);
  /** Dragging the inner edge: the capture keeps the pointer even over the neighboring web page. */
  function dragEdge(e: PointerEvent) {
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const [from, x0] = [barWidth, e.screenX];
    const agent = parseFloat(getComputedStyle(window.parent.document.documentElement).getPropertyValue("--webaios-agent")) || 0;
    // Always room for the page: 300 px at least beside the agent panel.
    const max = Math.max(BAR_WIDTH_MIN, Math.min(BAR_WIDTH_MAX, window.parent.innerWidth - agent - 300));
    // Screen coordinates: this iframe's own edge moves with the width.
    const wanted = (ev: PointerEvent) => Math.round(Math.max(BAR_WIDTH_MIN, Math.min(max, from + (sidebarRight ? x0 - ev.screenX : ev.screenX - x0))));
    const move = (ev: PointerEvent) => win.setSidebarWidth((dragged = wanted(ev)));
    const drop = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", drop);
      handle.removeEventListener("pointercancel", drop);
      api.dispatch({ type: "sidebarWidth", width: wanted(ev) });
      dragged = null;
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", drop);
    handle.addEventListener("pointercancel", drop);
  }
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

<div class="window" inert={welcome || !!agentRequest || !!spaceSettings.draft || !!command.open} class:compact class:covered={overlay} class:right={sidebarRight} style:--bar-w="{barWidth}px">
  <div class="column" class:folded-up={!barVisible} class:resume={unfinished && welcomeStep.aside} inert={!barVisible}>
    {#if winState}
      <!-- ✦ on a builder tab: the controller opens the panel and sends "agent", handled above. -->
      <Sidebar window={winState} togglePanel={togglePanel} builderAgent={() => win.openAgent()} />
    {:else}
      <aside data-testid="sidebar"></aside>
    {/if}
    <div class="edge" data-testid="sidebar-handle" role="separator" aria-orientation="vertical" aria-label="Largeur de la barre des onglets" onpointerdown={dragEdge}></div>
    <!-- The welcome stepped aside for an install page: the way back, under the sidebar (the only place this iframe
         covers beside a web page). -->
    {#if unfinished && welcomeStep.aside}
      <button class="resume-welcome" data-testid="welcome-resume" out:fade={{ duration: WELCOME_FADE_MS }} onclick={() => (welcomeStep.aside = false)}>Reprendre l'accueil</button>
    {/if}
  </div>
  <main class="content" class:framed={(!pageWeb || !!panel) && !(winState && !activeTab && !panel)} data-testid="content-zone">
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
    {:else if activeTab?.url === URL_RELEASE_NOTES}
      <ReleaseNotes />
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
{#if !welcome}<ContextMenu />{/if}
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
{#if designNote}
  <!-- A modal opening over it takes the window: the note's layer leaves with it. -->
  <div class="command-layer">
    <FrozenBackground tabId={activeTab?.id ?? null} onReady={() => {}} />
    <FirstTimeNote id="design" />
  </div>
{:else if !modalOpen && !agentNoteShowing() && activeTab?.url === URL_ACTIONS && !privateAction}
  <FirstTimeNote id="actions" veil />
{/if}
{#if welcomeLayer && winState}
  <div class="welcome-layer" class:leaving={!welcome} data-testid="welcome-layer"><Welcome window={winState} /></div>
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
  /* Above every other layer: nothing else is reachable until the welcome is finished. */
  .welcome-layer { position: fixed; inset: 0; z-index: 200; transition: opacity 150ms var(--out); }
  .welcome-layer.leaving { opacity: 0; pointer-events: none; }
  .tabs-layer { display: contents; }
  /* Under the command bar and ⌃Tab: the overlay veil, the window slightly blurred (the glass boxes blur more). */
  :is(.command-layer, .tabs-layer) :global(div.veil) { background: var(--overlay-veil); backdrop-filter: blur(6px); }
  .window {
    display: grid;
    grid-template-columns: var(--bar-w) 1fr;
    height: 100%;
  }
  .window.compact { grid-template-columns: 1fr; }
  /* The sidebar on the right (settings.sidebarSide): the same grid mirrored. */
  .window.right { grid-template-columns: 1fr var(--bar-w); }
  .window.right.compact { grid-template-columns: 1fr; }
  .right .column { order: 1; }
  .column { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; min-height: 0; }
  /* The sidebar's inner edge, dragged to set its width (as the agent panel's). */
  .edge { position: absolute; top: 0; bottom: 0; right: 0; width: 6px; cursor: col-resize; z-index: 1; -moz-window-dragging: no-drag; transition: background var(--tap); }
  .right .edge { right: auto; left: 0; }
  .edge:hover, .edge:active { background: color-mix(in srgb, var(--accent) 40%, transparent); }
  .column.resume { grid-template-rows: minmax(0, 1fr) auto; }
  .resume-welcome {
    justify-self: center;
    margin: 0 8px 10px;
    padding: 7px 16px;
    border: 1px solid var(--glass-edge);
    border-radius: 999px;
    background: var(--glass-hi);
    box-shadow: var(--float);
    color: var(--text);
    font: 600 12.5px var(--font-ui);
    -moz-window-dragging: no-drag;
    animation: webaios-rise var(--spring-d) var(--spring) backwards;
    transition: transform var(--tap), background var(--tap);
  }
  .resume-welcome:hover { background: var(--bg-active); }
  .resume-welcome:active { transform: scale(0.97); }
  .resume-welcome:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .compact .column {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 10;
    width: var(--bar-w);
    transition: transform 200ms var(--out);
  }
  /* Floating over the web page, which no backdrop blur of this document reaches: a solid sheet keeps it readable, a
     wash of the aura at its top keeps it of the family. */
  .compact .column :global(.bar) {
    background: linear-gradient(color-mix(in oklab, var(--a1) 14%, var(--sheet)), var(--sheet) 45%);
    box-shadow: var(--modal-shadow);
  }
  .compact.right .column { inset: 0 0 0 auto; }
  .compact .folded-up { transform: translateX(-100%); visibility: hidden; transition: transform 200ms var(--out), visibility 0s 200ms; }
  @media (prefers-reduced-motion: reduce) {
    .compact .column { transition: none; }
  }
  /* The action page fills it (position: absolute), not the window. */
  .content { position: relative; min-width: 0; min-height: 0; }
  /* No web page (window.css then hides the page box): an internal page takes its place, a glass sheet framed on the
     aura like a web page. The empty page sits on the aura itself. */
  .framed {
    margin: 8px 8px 8px 0;
    border: 1px solid var(--glass-edge);
    border-radius: 12px;
    /* No backdrop-filter: the aura is painted by the window, out of this document's reach; it would also become the
       containing block of the pages' fixed veils. */
    background: var(--glass);
    box-shadow: var(--float);
    overflow: hidden;
  }
  .compact .framed { margin-left: 8px; }
  .right .framed { margin: 8px 0 8px 8px; }
  .right.compact .framed { margin-right: 8px; }
  .compact.right .folded-up { transform: translateX(100%); }
  /* The page's error and crash messages. */
  .crashed { display: grid; place-content: center; gap: 12px; height: 100%; text-align: center; color: var(--text); }
</style>
