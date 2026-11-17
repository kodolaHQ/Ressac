<script lang="ts">
  // The agent panel of the window, in its own iframe.
  import { untrack } from "svelte";
  import AgentPanel from "./components/AgentPanel.svelte";
  import { focusAgent } from "./components/agent.svelte";
  import { api, appState, currentWindow } from "./state.svelte";
  import { AGENT_WIDTH_MAX, AGENT_WIDTH_MIN } from "../shared/model";

  const win = window.parent.ressacWindow!;
  const winState = $derived(currentWindow());
  const agentPanelOpen = $derived(winState?.agentPanelOpen ?? false);
  $effect(() => api.onShortcut((r) => r === "agent" && focusAgent.n++));

  // The panel opens only on the user's request (✦, ⌘J, ⌘T, or left open at the last quit), never on its own: the
  // window's session starts with it. Opening it gives the terminal the keyboard.
  let openedBefore = false;
  $effect(() => {
    if (agentPanelOpen && !openedBefore) untrack(() => focusAgent.n++);
    openedBefore = agentPanelOpen;
  });

  /** Width of this iframe when the drag started. */
  let start: number | null = null;
  function resize(wanted: number, end: boolean) {
    // On the left the handle measures in this iframe, whose left edge moves with the width: back to window coordinates.
    // On the right the iframe's left edge is the window's, nothing moves under the pointer.
    start ??= window.innerWidth;
    const real = appState.value?.settings.sidebarSide === "right" ? wanted : wanted - start + window.innerWidth;
    // Always room for the page: 300 px at least beside the sidebar.
    const max = Math.min(AGENT_WIDTH_MAX, window.parent.innerWidth - win.sidebarWidth() - 300);
    const width = Math.round(Math.max(AGENT_WIDTH_MIN, Math.min(max, real)));
    win.setAgentWidth(width);
    if (end) {
      start = null;
      api.dispatch({ type: "agentPanelWidth", width: width });
    }
  }
</script>

<AgentPanel visible={agentPanelOpen} resize={resize} />

<style>
  :global(html), :global(body) { height: 100%; margin: 0; }
  :global(body) { display: flex; }
  :global(body > .agent) { flex: 1; }
</style>
