<script lang="ts">
  import { tick, untrack } from "svelte";
  import { fade } from "svelte/transition";
  import { aiOn, api, appState as browserState } from "../state.svelte";
  import AiAsleep from "./AiAsleep.svelte";
  import { t } from "../i18n.svelte";
  import type { AgentAccount } from "../../shared/settings";
  import { focusAgent } from "./agent.svelte";
  import * as terminalAgent from "./terminalAgent.svelte";
  import FirstTimeNote from "./FirstTimeNote.svelte";
  import { firstTimePending } from "./hints";

  let {
    visible,
    builtin: builtIn = false,
    resize,
  }: {
    visible: boolean;
    /** In the builder's « Agent » tab: no width handle, always shown in its host. */
    builtin?: boolean;
    /** The user drags the inner edge: wanted width in pixels; `fin` on release. */
    resize?: (width: number, end: boolean) => void;
  } = $props();
  let section: HTMLElement;
  /** The agent's first-time note waits, unseen, while AI is off. */
  const notePending = () => aiOn() && firstTimePending("agent");

  /** The panel is on the left when the sidebar is on the right: the handle follows the panel's inner edge. */
  const sidebarRight = $derived(browserState.value?.settings.sidebarSide === "right");
  /** Dragging the inner edge: the capture keeps the pointer even over the neighboring web page. */
  function tirer(e: PointerEvent) {
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const start = e.clientX;
    // The frame's width, as resize() takes it: the section leaves out the panel's 8 px margin.
    const width = window.innerWidth;
    // The pointer moving right grows a panel whose handle is on its right edge, and shrinks one whose handle is on its left.
    const direction = sidebarRight ? 1 : -1;
    const wanted = (ev: PointerEvent) => width + direction * (ev.clientX - start);
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
  let engineNotice = $state<HTMLElement>();
  /** Ticks while a build step shows, so the elapsed minutes count up. */
  let now = $state(Date.now());
  $effect(() => {
    if (appState.state !== "preparing" || appState.since === undefined) return;
    const timer = setInterval(() => (now = Date.now()), 5_000);
    return () => clearInterval(timer);
  });

  let profiles = $state<{ id: string; name: string }[]>([]);
  let accounts = $state<AgentAccount[]>([]);
  /** The window's own agent (the host's), not the setting: switching only concerns this window. */
  let current = $state<string | null>(null);
  const refreshAccounts = () => api.settings.agents().then((a) => (accounts = a), () => {});
  $effect(() => {
    if (!visible || !aiOn()) return;
    api.agent.profiles().then((p) => (profiles = p), () => {});
    void refreshAccounts();
  });
  // Read again at each state the host sends (a switch or a restart changes it).
  // Only the latest read applies: an older answer must not overwrite a newer one.
  let reads = 0;
  const readCurrent = () => {
    const n = ++reads;
    return api.agent.current().then((c) => void (n === reads && (current = c)), () => {});
  };
  $effect(() => {
    void appState;
    if (aiOn()) void readCurrent();
  });
  const account = (id: string | null) => accounts.find((a) => a.id === id);
  /** Whether an agent runs on its subscription (the sign-in it needs); Claude or Codex on Ollama or an API does not. */
  const onSubscription = (id: string) =>
    id === "codex" ? browserState.value?.settings.codexEngine.kind === "chatgpt" : id === "claude" ? (browserState.value?.settings.claudeEngine.kind ?? "subscription") === "subscription" : true;
  const signedOutCodex = $derived(current === "codex" && onSubscription("codex") && account("codex")?.state === "logged-out");
  const profileChoice = $derived(profiles.length >= 2);
  // Only the shipped agents know how to run without their shell (kernel's openAgentSession).
  const modeChoice = $derived(current === "claude" || current === "codex");
  const mode = $derived(browserState.value?.settings.agentMode ?? "browser");
  function chooseMode(m: "browser" | "workshop") {
    if (m === mode) return;
    // Dispatch is synchronous: the host gets the new mode before the relaunch request.
    api.dispatch({ type: "chooseAgentMode", mode: m });
    void api.agent.relaunch();
  }
  async function choose(id: string) {
    reads++;
    current = id;
    await api.agent.switch(id);
    void readCurrent();
    void refreshAccounts();
  }

  // The window's terminal comes here on the first opening of this panel, then stays attached: closing the panel only
  // hides it, the conversation goes on. The « Agent » tab borrows it while it is shown.
  // Becoming visible again (leaving the builder, the home page reopening it) does not take the keyboard: a keystroke
  // followed by Enter would go to the agent. Only an explicit request (focusAgent) gives it to the terminal.
  let detach: (() => void) | undefined;
  $effect(() => () => detach?.());
  $effect(() => {
    if (!aiOn()) terminalAgent.sleep();
  });
  $effect(() => {
    // AI off: the terminal is not attached, so no agent session starts.
    if (!visible || !aiOn()) return;
    detach ??= terminalAgent.attacher(hostEl);
    terminalAgent.wake();
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

  // ⌘J from a web page: the keyboard goes from the page to the interface. A focus requested during this handover or the
  // panel's slide can be lost at the window level: it is requested again shortly after, and once the slide is over.
  $effect(() => {
    const n = focusAgent.n;
    if (!visible) {
      served = n;
      return;
    }
    if (n === served) return;
    served = n;
    if (notePending()) userAsked = true;
    // The first-time note keeps the keyboard until Compris.
    const aim = () => visible && !notePending() && terminalAgent.focus();
    void tick().then(aim);
    const relaunches = [100, 500].map((ms) => setTimeout(() => !terminalAgent.hasFocus() && aim(), ms));
    return () => relaunches.forEach(clearTimeout);
  });
  // The note takes the keyboard; Compris gives it back: to the terminal if the user opened the panel (⌘J, ✦), else to
  // where it was (the empty page's field when the home page opened the panel). Captured before the note mounts.
  let giveBack: (() => void) | undefined;
  let userAsked = false;
  $effect.pre(() => {
    const pending = visible && notePending();
    const done = !notePending();
    untrack(() => {
      if (pending) giveBack ??= window.parent.ressacWindow?.rememberFocus();
      else if (done && giveBack) {
        const back = giveBack;
        const asked = userAsked;
        giveBack = undefined;
        userAsked = false;
        void tick().then(() => (asked ? terminalAgent.focus() : back()));
      }
    });
  });
  // Shown with its note pending, the panel gives the keyboard to the note's button.
  $effect(() => {
    if (visible && notePending()) void tick().then(() => section?.querySelector<HTMLElement>('[data-testid="first-time-ok"]')?.focus());
  });
</script>

<section class="agent" class:built-in={builtIn} class:right={sidebarRight} data-testid={builtIn ? "built-in-agent-terminal" : "agent-panel"} hidden={!visible} bind:this={section}>
  {#if aiOn()}<FirstTimeNote id="agent" />{/if}
  {#if !builtIn}
    <div class="handle" data-testid="agent-handle" role="separator" aria-orientation="vertical" aria-label={t("agent-panel-handle")} onpointerdown={tirer}></div>
  {/if}
  {#if !aiOn()}
    <AiAsleep feature="agent" />
  {:else}
  <header>
    <!-- The agent's mark: the aura's three hues, turning while it answers. -->
    <span class="orb" class:busy={terminalAgent.agent.busy} data-testid="agent-orb" aria-hidden="true"></span>
    {#if profileChoice}
      <select
        data-testid="agent-profile"
        aria-label={t("agent-panel-label")}
        value={current ?? ""}
        onchange={(e) => choose(e.currentTarget.value)}
      >
        {#each profiles as p (p.id)}<option value={p.id}>{account(p.id)?.state === "logged-out" && onSubscription(p.id) ? t("agent-panel-signed-out", { name: p.name }) : p.name}</option>{/each}
      </select>
    {:else}
      <span class="name">{profiles.find((p) => p.id === current)?.name ?? t("agent-panel-label")}</span>
    {/if}
    {#if modeChoice}
      <div class="mode" data-testid="agent-mode" role="radiogroup" aria-label={t("agent-panel-mode")} out:fade={{ duration: 150 }}>
        {#each ["browser", "workshop"] as const as m (m)}
          <button role="radio" aria-checked={mode === m} data-testid="agent-mode-{m}" title={t(`agent-panel-mode-${m}-title`)} onclick={() => chooseMode(m)}>{t(`agent-panel-mode-${m}`)}</button>
        {/each}
      </div>
    {/if}
  </header>
  {#if signedOutCodex}
    <p class="message">{t("agent-panel-codex-signed-out")}</p>
    <button data-testid="agent-login-settings" onclick={() => api.dispatch({ type: "openSettings", windowId: api.windowId })}>{t("agent-panel-login")}</button>
  {/if}
  {#if appState.state === "active" && appState.engineChanged}
    <!-- A fade never ends in a hidden panel (no frames): off screen, the notice leaves at once. -->
    <div class="engine-changed" data-testid="agent-engine-changed" bind:this={engineNotice} out:fade={{ duration: engineNotice?.getClientRects().length ? 150 : 0 }}>
      <p class="message">{t("agent-panel-engine-changed")}</p>
      <button data-testid="agent-engine-relaunch" onclick={() => void api.agent.relaunch()}>{t("agent-panel-restart")}</button>
    </div>
  {/if}
  {#if appState.state === "preparing"}
    {#if appState.step !== undefined && appState.since !== undefined}
      <p class="message" data-testid="agent-build-step">{t("agent-panel-build-step", { step: appState.step, of: appState.of ?? 0, label: appState.label ?? "", minutes: Math.max(0, Math.floor((now - appState.since) / 60_000)) })}</p>
    {:else}
      <p class="message">{t("agent-panel-preparing")}</p>
    {/if}
  {:else if appState.state === "docker-absent"}
    <p class="message">{t("agent-panel-docker-absent")}</p>
    <button onclick={terminalAgent.reset}>{t("agent-panel-retry")}</button>
  {:else if appState.state === "error"}
    <p class="message">{t("agent-panel-error", { message: appState.message })}</p>
    <button onclick={terminalAgent.reset}>{t("agent-panel-retry")}</button>
  {:else if appState.state === "done"}
    <p class="message">{t("agent-panel-done")}</p>
    <button onclick={terminalAgent.reset}>{t("agent-panel-restart")}</button>
  {/if}
  {/if}
  <div class="terminal" bind:this={hostEl} hidden={!aiOn()} class:masked={appState.state !== "active" && appState.state !== "done"}></div>
</section>

<style>
  /* A glass pane floating on the aura, like the sidebar: 8 px from the window, the page's gap on its left. */
  .agent { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; margin: 8px 8px 8px 0; background: var(--glass); border: 1px solid var(--glass-edge); border-radius: 16px; box-shadow: var(--lift); overflow: hidden; }
  .agent.right { margin: 8px 0 8px 8px; }
  .agent[hidden] { display: none; }
  .agent.built-in { flex: 1; margin: 0; border: none; border-radius: 0; box-shadow: none; }
  .handle { position: absolute; top: 0; bottom: 0; left: 0; width: 6px; cursor: col-resize; z-index: 1; transition: background var(--tap); }
  .right .handle { left: auto; right: 0; }
  .handle:hover, .handle:active { background: color-mix(in srgb, var(--accent) 40%, transparent); }
  /* The panel's header moves the window, its menu aside. */
  header { display: flex; align-items: center; gap: 9px; height: 40px; padding: 0 12px; flex: none; -moz-window-dragging: drag; }
  header select { -moz-window-dragging: no-drag; }
  .orb { flex: none; width: 14px; height: 14px; border-radius: 50%; background: conic-gradient(from var(--ang), var(--a1), var(--a2), var(--a3), var(--a1)); box-shadow: 0 0 0 3px color-mix(in oklab, var(--a2) 16%, transparent); transition: box-shadow 300ms var(--out); }
  .orb.busy { animation: orb-spin 1.8s linear infinite; box-shadow: 0 0 0 3px color-mix(in oklab, var(--a2) 28%, transparent), 0 0 12px color-mix(in oklab, var(--a1) 55%, transparent); }
  @keyframes orb-spin { to { --ang: 360deg; } }
  @media (prefers-reduced-motion: reduce) { .orb.busy { animation: none; } }
  .name { font: 600 14px/1 var(--font-display); letter-spacing: -0.01em; }
  select { appearance: none; padding: 5px 26px 5px 10px; border-radius: 10px; border: 1px solid var(--border); background: linear-gradient(45deg, transparent 50%, var(--text-muted) 50%) no-repeat right 14px center / 5px 5px, linear-gradient(-45deg, transparent 50%, var(--text-muted) 50%) no-repeat right 9px center / 5px 5px, var(--glass-hi); color: var(--text); font: 600 13px/1.2 var(--font-display); transition: transform var(--tap), border-color var(--tap); }
  select:hover { border-color: var(--glass-edge); }
  select:active { transform: scale(0.97); }
  select:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .message { margin: 4px 14px 10px; color: var(--text-muted); line-height: 1.45; }
  button { margin: 0 14px 12px; align-self: flex-start; padding: 6px 14px; border-radius: 10px; border: 0; background: var(--accent); color: var(--accent-ink); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap); }
  button:active { transform: scale(0.97); }
  /* The terminal (terminalAgent) is placed in it absolutely, 6 px from the edge: a sheet set inside the glass. */
  .terminal { position: relative; flex: 1; min-height: 0; margin: 0 6px 6px; border-radius: 11px; background: var(--sheet); box-shadow: inset 0 0 0 1px var(--border); }
  .built-in .terminal { margin: 0; border-radius: 0; box-shadow: none; }
  .terminal.masked { visibility: hidden; }
  /* Two options in one glass pill, the chosen one lifted (like the Applications filters). */
  .mode { display: flex; gap: 2px; padding: 2px; margin-left: auto; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); -moz-window-dragging: no-drag; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .mode button { margin: 0; padding: 4px 10px; border-radius: 8px; background: transparent; color: var(--text-muted); font: 600 12px/1.2 var(--font-ui); transition: transform var(--tap), background var(--tap), color var(--tap); }
  .mode button[aria-checked="true"] { background: var(--glass); color: var(--text); box-shadow: var(--lift), inset 0 0 0 1px var(--glass-edge); }
  .engine-changed { display: flex; flex-direction: column; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .terminal[hidden] { display: none; }
</style>
