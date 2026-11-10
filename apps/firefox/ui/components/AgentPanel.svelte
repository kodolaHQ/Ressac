<script lang="ts">
  import { tick, untrack } from "svelte";
  import { api, appState as browserState } from "../state.svelte";
  import { focusAgent } from "./agent.svelte";
  import * as terminalAgent from "./terminalAgent.svelte";

  let {
    visible,
    builtin: builtIn = false,
    resize: resize,
  }: {
    visible: boolean;
    /** In the builder's « Agent » tab: no width handle, always shown in its host. */
    builtin?: boolean;
    /** The user drags the left edge: wanted width in pixels; `fin` on release. */
    resize?: (width: number, end: boolean) => void;
  } = $props();
  let section: HTMLElement;

  /** Dragging the left edge: the capture keeps the pointer even over the neighboring web page. */
  function tirer(e: PointerEvent) {
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const start = e.clientX;
    const width = section.getBoundingClientRect().width;
    const wanted = (ev: PointerEvent) => width + start - ev.clientX;
    const move = (ev: PointerEvent) => resize?.(wanted(ev), false);
    const drop = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", drop);
      handle.removeEventListener("pointercancel", drop);
      resize?.(wanted(ev), true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", drop);
    handle.addEventListener("pointercancel", drop);
  }
  let hostEl: HTMLDivElement;
  const appState = $derived(terminalAgent.agent.state);

  let profiles = $state<{ id: string; name: string }[]>([]);
  const agentProfile = $derived(browserState.value?.settings.agentProfile ?? "claude");
  $effect(() => {
    if (visible) api.agent.profiles().then((p) => (profiles = p), () => {});
  });
  // A single profile: nothing to choose. The menu stays if the chosen profile has disappeared, so it can be changed.
  const profileChoice = $derived(profiles.length >= 2 || (profiles.length > 0 && !profiles.some((p) => p.id === agentProfile)));

  // The window's terminal comes here on the first opening of this panel, then stays attached: closing the panel only
  // hides it, the conversation goes on. The « Agent » tab borrows it while it is shown.
  // Becoming visible again (leaving the builder, the home page reopening it) does not take the keyboard: a keystroke
  // followed by Enter would go to the agent. Only an explicit request (focusAgent) gives it to the terminal.
  let detach: (() => void) | undefined;
  $effect(() => () => detach?.());
  $effect(() => {
    if (!visible) return;
    detach ??= terminalAgent.attacher(hostEl);
    terminalAgent.adjust();
    const obs = new ResizeObserver(() => terminalAgent.adjust());
    obs.observe(hostEl);
    return () => obs.disconnect();
  });

  // Last focus request served. A request made while this panel is hidden does not concern it (⌘J in the builder
  // targets its « Agent » tab): it is dropped. The « Agent » tab, though, always shows on the user's request (click,
  // ⌘J, ✦): it takes the keyboard as soon as it is mounted.
  // svelte-ignore state_referenced_locally
  let served = builtIn ? -1 : untrack(() => focusAgent.n);

  // ⌘J from a web page: the keyboard goes from the page to the interface. During this handover, Chromium ignores a
  // focus requested too early: it is requested again shortly after if the terminal does not have it.
  $effect(() => {
    const n = focusAgent.n;
    if (!visible) {
      served = n;
      return;
    }
    if (n === served) return;
    served = n;
    const aim = () => visible && terminalAgent.focus();
    void tick().then(aim);
    const relaunch = setTimeout(() => !terminalAgent.hasFocus() && aim(), 100);
    return () => clearTimeout(relaunch);
  });
</script>

<section class="agent" class:built-in={builtIn} data-testid={builtIn ? "built-in-agent-terminal" : "agent-panel"} hidden={!visible} bind:this={section}>
  {#if !builtIn}
    <div class="handle" data-testid="agent-handle" role="separator" aria-orientation="vertical" aria-label="Largeur du panneau agent" onpointerdown={tirer}></div>
  {/if}
  {#if profileChoice}
    <header>
      <select
        data-testid="agent-profile"
        aria-label="Profil d'agent"
        value={agentProfile}
        onchange={(e) => api.dispatch({ type: "chooseAgentProfile", profile: e.currentTarget.value })}
      >
        {#each profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
      </select>
    </header>
  {/if}
  {#if appState.state === "preparing"}
    <p class="message">Préparation de l'agent… (la première fois, la construction du conteneur prend quelques minutes)</p>
  {:else if appState.state === "docker-absent"}
    <p class="message">Docker n'est pas lancé. La navigation fonctionne ; seul l'agent est indisponible.</p>
    <button onclick={terminalAgent.reset}>Réessayer</button>
  {:else if appState.state === "error"}
    <p class="message">L'agent n'a pas pu démarrer : {appState.message}</p>
    <button onclick={terminalAgent.reset}>Réessayer</button>
  {:else if appState.state === "done"}
    <p class="message">L'agent s'est arrêté.</p>
    <button onclick={terminalAgent.reset}>Relancer</button>
  {/if}
  <div class="terminal" bind:this={hostEl} class:masked={appState.state !== "active" && appState.state !== "done"}></div>
</section>

<style>
  .agent { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg-bar); border-left: 1px solid var(--border); }
  .agent[hidden] { display: none; }
  .agent.built-in { flex: 1; border-left: none; }
  .handle { position: absolute; top: 0; bottom: 0; left: -3px; width: 6px; cursor: col-resize; z-index: 1; }
  .handle:hover, .handle:active { background: color-mix(in srgb, var(--accent) 40%, transparent); }
  .message { margin: 12px; color: var(--text-muted); }
  header { padding: 6px 8px; border-bottom: 1px solid var(--border); }
  select { padding: 2px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-active); color: var(--text); font-size: 12px; }
  button { margin: 0 12px 12px; align-self: flex-start; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-active); color: var(--text); }
  /* The terminal (terminalAgent) is placed in it absolutely, 6 px from the edge. */
  .terminal { position: relative; flex: 1; min-height: 0; background: #1e1e22; }
  .terminal.masked { visibility: hidden; }
</style>
