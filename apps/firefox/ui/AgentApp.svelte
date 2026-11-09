<script lang="ts">
  // The agent panel of the window, in its own iframe.
  import { untrack } from "svelte";
  import AgentPanel from "./components/AgentPanel.svelte";
  import { focusAgent } from "./components/agent.svelte";
  import { api, appState, currentWindow } from "./state.svelte";
  import { AGENT_WIDTH_MAX, AGENT_WIDTH_MIN } from "../shared/model";

  const win = window.parent.webaiosWindow!;
  const winState = $derived(currentWindow());
  const agentPanelOpen = $derived(winState?.agentPanelOpen ?? false);
  const activeTab = $derived.by(() => {
    const id = winState?.active[winState.activeSpace];
    return id ? appState.value?.tabs[id] : undefined;
  });
  $effect(() => api.onShortcut((r) => r === "agent" && focusAgent.n++));

  // The panel is open by default on the home page (the agent's session starts there), and closes
  // when leaving it if it opened only for it. Closed by the user on the home page, it stays closed there until next launch.
  let panelClosedOnHome = false;
  /** Opening asked by the home page, not back in the state yet (null: none). */
  let expected: boolean | null = null;
  let openedByHome = false;
  let openedBefore = false;
  $effect(() => {
    const isOpen = agentPanelOpen;
    const f = winState;
    if (!f) return;
    const onHome = !activeTab;
    if (isOpen !== openedBefore) {
      // A change from elsewhere (⌘J, ✦ button): the panel now belongs to the user.
      const ofUser = isOpen !== expected;
      // Opened by the user: the terminal takes the keyboard. Opened again by the home page: it does not.
      if (ofUser && isOpen) untrack(() => focusAgent.n++);
      if (ofUser) openedByHome = false;
      if (ofUser && onHome && !isOpen) panelClosedOnHome = true;
      expected = null;
    }
    openedBefore = isOpen;
    // A tab showed before the opening went through: it was refused (see panneauAgentAccueil).
    if (!onHome && !isOpen) {
      expected = null;
      openedByHome = false;
    }
    // The action is idempotent: sending it again until the state reflects it toggles nothing.
    const ask = (v: boolean) => {
      expected = v;
      api.dispatch({ type: "panneauAgentAccueil", windowId: f.id, open: v });
    };
    if (onHome && !isOpen && !panelClosedOnHome) {
      openedByHome = true;
      ask(true);
    } else if (!onHome && isOpen && openedByHome) {
      openedByHome = false;
      ask(false);
    }
  });

  /** Width of this iframe when the drag started. */
  let start: number | null = null;
  function resize(wanted: number, end: boolean) {
    // The handle measures in this iframe, whose left edge moves with the width: back to window coordinates.
    start ??= window.innerWidth;
    const real = wanted - start + window.innerWidth;
    // Always room for the page: 300 px at least beside the sidebar.
    const max = Math.min(AGENT_WIDTH_MAX, window.parent.innerWidth - win.sidebarWidth() - 300);
    const width = Math.round(Math.max(AGENT_WIDTH_MIN, Math.min(max, real)));
    win.setAgentWidth(width);
    if (end) {
      start = null;
      api.dispatch({ type: "largeurPanneauAgent", width: width });
    }
  }
</script>

<AgentPanel visible={agentPanelOpen} resize={resize} />

<style>
  :global(html), :global(body) { height: 100%; margin: 0; }
  :global(body) { display: flex; }
  :global(body > .agent) { flex: 1; }
</style>
