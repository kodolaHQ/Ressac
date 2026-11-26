<script lang="ts">
  import { tick, untrack } from "svelte";
  import { fade } from "svelte/transition";
  import { aiOn, api, appState as browserState, labOn } from "../state.svelte";
  import AiAsleep from "./AiAsleep.svelte";
  import { t } from "../i18n.svelte";
  import type { AgentAccount } from "../../shared/settings";
  import type { MaskingStatus } from "../../shared/api";
  import { passportName } from "../../shared/model";
  import { NO_MASKING } from "../api";
  import { focusAgent } from "./agent.svelte";
  import * as terminalAgent from "./terminalAgent.svelte";
  import FirstTimeNote from "./FirstTimeNote.svelte";
  import InstructionReview from "./InstructionReview.svelte";
  import LiftLock from "./LiftLock.svelte";
  import MaskBubble from "./MaskBubble.svelte";
  import { passportTip, uncoveredText } from "./maskBanner";
  import { firstTimePending } from "./hints";
  import { chat, openChat } from "./chat/chat.svelte";
  import ChatHeader from "./chat/ChatHeader.svelte";
  import ChatList from "./chat/ChatList.svelte";
  import ChatView from "./chat/ChatView.svelte";

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
  /** Réglages on its Agent section: the window's UI frame owns the section shown, as for the menu's « Réglages › … ». */
  const openSettings = (r: "settings:agent" | `settings:passport:${string}`) => {
    const win = window.parent.ressacWindow;
    if (win) win.shortcut({ type: "shortcut", r });
    else api.dispatch({ type: "openSettings", windowId: api.windowId });
  };
  const openAgentSettings = () => openSettings("settings:agent");

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
  // State: the bubble shows in the panel whose host holds the terminal.
  let hostEl = $state<HTMLDivElement>() as HTMLDivElement;
  const appState = $derived(terminalAgent.agent.state);
  let engineNotice = $state<HTMLElement>();
  /** What the panel prepares: the active discussion's start in chat view, the terminal's session otherwise. */
  const prep = $derived(chatMode ? (chat.view?.preparing ?? null) : appState.state === "preparing" || appState.state === "review" ? appState : null);
  /** Ticks while a build step shows, so the elapsed minutes count up. */
  let now = $state(Date.now());
  $effect(() => {
    if (prep?.state !== "preparing" || prep.since === undefined) return;
    const timer = setInterval(() => (now = Date.now()), 5_000);
    return () => clearInterval(timer);
  });

  /** While the panel prepares: Ressac's workshop machine is booting (asked every 2 s). */
  let machineStarting = $state(false);
  $effect(() => {
    if (prep?.state !== "preparing" || !aiOn()) return void (machineStarting = false);
    const check = () => api.settings.machine().then((m) => (machineStarting = m?.kind === "starting"), () => {});
    void check();
    const timer = setInterval(check, 2_000);
    return () => clearInterval(timer);
  });

  /** The masking banners (lock, conversation not covered, kernel notice): read again on each change the host tells. */
  let masking = $state<MaskingStatus>(NO_MASKING);
  let maskReads = 0;
  const readMasking = () => {
    const n = ++maskReads;
    void api.agent.masking().then((m) => void (n === maskReads && (masking = m)));
  };
  $effect(() => {
    if (!aiOn()) return void (masking = NO_MASKING);
    untrack(readMasking);
    return api.agent.onMasking(readMasking);
  });
  // A new session (relaunch, resume) changes what the window's conversation is.
  $effect(() => {
    void appState;
    if (aiOn()) untrack(readMasking);
  });
  /** The lift card is open (« Lever le verrou »): it goes with the lock. */
  let lifting = $state(false);
  $effect(() => {
    if (!masking.locked) lifting = false;
  });
  const uncoveredKey = $derived(uncoveredText(masking));
  /** The passport banner's tooltip: the added entries' names and masked displays, read from the chrome's passport on demand. */
  let tip = $state<string | null>(null);
  let tips = 0;
  const showTip = () => {
    const n = ++tips;
    void api.agent.passportShown($state.snapshot(masking.uncoveredPassport)).then((shown) => void (n === tips && (tip = passportTip(shown, (id) => t(id)))));
  };
  const hideTip = () => {
    tips++;
    tip = null;
  };
  // A banner that leaves or changes takes its tooltip with it: the next one starts without.
  $effect(() => {
    void uncoveredKey;
    void masking.uncoveredPassport;
    untrack(hideTip);
  });
  const nameOf = (profile: string) => passportName(browserState.value?.spaces ?? [], profile, t("agent-mask-passport-no-space"));
  const lockedText = $derived(masking.locked && (masking.locked.length ? t("agent-mask-locked", { names: masking.locked.slice(0, 10).map((n) => n.slice(0, 60)).join(", "), agreement: masking.lockedAgreement }) : t("agent-mask-locked-unnamed")));

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
  // The sign-in finishes elsewhere (/login in the terminal, Réglages): read the account again until it does.
  $effect(() => {
    void appState;
    if (!visible || !current || !onSubscription(current) || account(current)?.state !== "logged-out") return;
    void refreshAccounts();
    const timer = setInterval(() => void refreshAccounts(), 3000);
    return () => clearInterval(timer);
  });
  const profileChoice = $derived(profiles.length >= 2);
  // Every profile: Navigateur runs only Claude Code and Codex, a custom profile asks for Atelier (the kernel says so).
  const modeChoice = $derived(current !== null);
  // The effective mode, as the host runs it: Atelier saved while the lab is off (or undecided) runs Navigateur.
  const mode = $derived(labOn() ? (browserState.value?.settings.agentMode ?? "browser") : "browser");
  function chooseMode(m: "browser" | "workshop") {
    if (m === mode) return;
    // Dispatch is synchronous: the host gets the new mode before the relaunch request.
    api.dispatch({ type: "chooseAgentMode", mode: m });
    void api.agent.relaunch();
  }
  /**
   * The agent view « Discussion » (Réglages › Agent), for Claude Code and Codex: a custom profile, the setting
   * « Terminal » or « Mode avancé » show the terminal. The profile is assumed shipped until the host says.
   */
  let advanced = $state(false);
  const chatView = $derived((browserState.value?.settings.agentView ?? "chat") === "chat" && (current === null || current === "claude" || current === "codex"));
  const chatMode = $derived(aiOn() && chatView && !advanced);
  // « Votre modèle » once its kind has a model (Réglages › Agent).
  const ownSetting = $derived(browserState.value?.settings.ownEngine);
  const ownReady = $derived(!!ownSetting && !!(ownSetting.kind === "ollama" ? ownSetting.ollamaModel : ownSetting.apiModel));
  const chatProfiles = $derived([...profiles.filter((p) => p.id === "claude" || p.id === "codex"), ...(ownReady ? [{ id: "own", name: t("chat-engine-own") }] : [])]);
  let chatPane = $state<ReturnType<typeof ChatView>>();
  $effect(() => void (chat.visible = visible));
  // Shown in chat view: the window's active discussion (made if none, a paused one resumes).
  $effect(() => {
    if (visible && chatMode) untrack(() => void openChat());
  });
  $effect(() => {
    if (!chatMode) chat.listOpen = false;
  });
  // The host says when the window's panel is in « Mode avancé » (a UI reload forgets it): the terminal shows again.
  $effect(() => {
    if (chat.view?.advanced) untrack(() => (advanced = true));
  });
  /** A failed switch between the chat and the terminal, said in the panel until the next one. */
  let switchError = $state<string | null>(null);
  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
  /** « Mode avancé »: the discussion pauses, the window's terminal resumes its conversation. */
  async function toTerminal() {
    switchError = null;
    const had = terminalAgent.exists();
    try {
      await api.chat.toTerminal();
    } catch (e) {
      return void (switchError = reason(e));
    }
    advanced = true;
    // A terminal made earlier needs a new start; a first one starts as it attaches.
    if (had) terminalAgent.reset();
  }
  /** « Revenir au chat »: the terminal stops, the discussion resumes. */
  async function toChat() {
    switchError = null;
    try {
      await api.chat.toChat();
    } catch (e) {
      return void (switchError = reason(e));
    }
    advanced = false;
  }
  const chatReview = (id: number, choice: "keep" | "revert") => Promise.resolve(api.chat.review(id, choice));
  /** Where the keyboard goes for ⌘J: the composer in chat view, the terminal otherwise. */
  const focusTarget = () => (chatMode ? chatPane?.focus() : terminalAgent.focus());
  const targetHasFocus = () => (chatMode ? (chatPane?.hasFocus() ?? false) : terminalAgent.hasFocus());

  async function choose(id: string) {
    reads++;
    current = id;
    await api.agent.switch(id);
    void readCurrent();
    void refreshAccounts();
  }

  // Hidden, the panel drops its bubble: a revealed value or a held paste never waits off screen.
  $effect(() => {
    if (!visible) untrack(() => terminalAgent.bubble.current && section?.contains(terminalAgent.bubble.current.host) && terminalAgent.dismissBubble());
  });

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
    // AI off, or the chat shown: the terminal is not attached, so no terminal session starts.
    if (!visible || !aiOn() || chatMode) return;
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
      focusOwed = false;
      return;
    }
    if (n === served) return;
    served = n;
    focusOwed = untrack(() => !chatMode && appState.state !== "active");
    // Untracked: a note change re-running this effect would clear the retries below, then return (request served).
    if (untrack(notePending)) userAsked = true;
    // The first-time note keeps the keyboard until Compris.
    const aim = () => visible && !notePending() && focusTarget();
    void tick().then(aim);
    const relaunches = [100, 500].map((ms) => setTimeout(() => !targetHasFocus() && aim(), ms));
    return () => relaunches.forEach(clearTimeout);
  });
  /** Asleep, then waking until active: the terminal stays shown, so it keeps the keyboard for the keys typed meanwhile. */
  let waking = $state(false);
  $effect.pre(() => {
    const s = appState.state;
    untrack(() => (waking = s === "asleep" || (waking && s === "preparing")));
  });
  // A session still preparing masks its terminal, which cannot take the keyboard: it does once active (a first opening),
  // unless the user went elsewhere meanwhile (a page, the address bar): the agent may take seconds to start, and the keys
  // typed there must not jump into its terminal: served only while this panel still holds the window's focus (its request
  // focused it; the top document's activeElement follows the focus into any other frame or page).
  let focusOwed = false;
  $effect(() => {
    if (appState.state !== "active" || !visible) return;
    untrack(() => {
      const stillHere = window.parent.document.activeElement === window.frameElement;
      if (focusOwed && stillHere && !notePending()) void tick().then(() => visible && !terminalAgent.hasFocus() && terminalAgent.focus());
      focusOwed = false;
    });
  });
  // The note takes the keyboard; Compris gives it back: to the terminal if the user opened the panel (⌘J, ✦), else to
  // where it was (a panel left open at the last quit, shown again at launch). Captured before the note mounts.
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
        void tick().then(() => (asked ? focusTarget() : back()));
      }
    });
  });
  // Shown with its note pending, the panel gives the keyboard to the note's button.
  $effect(() => {
    if (visible && notePending()) void tick().then(() => section?.querySelector<HTMLElement>('[data-testid="first-time-ok"]')?.focus());
  });
</script>

<!-- The preparing states, under the terminal's header or above the chat's composer. -->
{#snippet preparing()}
  {#if prep?.state === "preparing"}
    {#if prep.step !== undefined && prep.since !== undefined}
      <p class="message" data-testid="agent-build-step">{t("agent-panel-build-step", { step: prep.step, of: prep.of ?? 0, label: prep.label ?? "", minutes: Math.max(0, Math.floor((now - prep.since) / 60_000)) })}</p>
    {:else}
      <p class="message">{t(machineStarting ? "agent-panel-machine-starting" : "agent-panel-preparing")}</p>
    {/if}
  {:else if prep?.state === "review"}
    <InstructionReview id={prep.id} files={prep.files} {visible} onAnswer={chatMode ? chatReview : undefined} />
  {/if}
{/snippet}

<section class="agent" class:built-in={builtIn} class:right={sidebarRight} data-testid={builtIn ? "built-in-agent-terminal" : "agent-panel"} hidden={!visible} bind:this={section}>
  {#if aiOn()}<FirstTimeNote id="agent" />{/if}
  {#if !builtIn}
    <div class="handle" data-testid="agent-handle" role="separator" aria-orientation="vertical" aria-label={t("agent-panel-handle")} onpointerdown={tirer}></div>
  {/if}
  {#if !aiOn()}
    <AiAsleep feature="agent" />
  {:else}
  {#if chatMode}
    <ChatHeader profiles={chatProfiles} onAdvanced={() => void toTerminal()} />
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
          <!-- Atelier is tier 3: with the lab off, it says so and takes no press. -->
          {@const locked = m === "workshop" && !labOn()}
          <button role="radio" aria-checked={mode === m} data-testid="agent-mode-{m}" disabled={locked} title={t(locked ? "agent-panel-mode-workshop-lab-title" : `agent-panel-mode-${m}-title`)} onclick={() => chooseMode(m)}>{t(locked ? "agent-panel-mode-workshop-lab" : `agent-panel-mode-${m}`)}</button>
        {/each}
      </div>
    {/if}
    {#if advanced && chatView}
      <button class="back" data-testid="chat-back" in:fade={{ duration: 150 }} onclick={() => void toChat()}>{t("chat-back")}</button>
    {/if}
  </header>
  {/if}
  <!-- A fade never ends in a hidden panel (no frames): off screen, a banner leaves at once. -->
  {#if lockedText}
    <div class="mask-banner lock" data-testid="agent-mask-locked-banner" out:fade={{ duration: visible ? 150 : 0 }}>
      <p role="status" data-testid="agent-mask-locked">{lockedText}</p>
      {#if !lifting}<button class="lift-open" data-testid="agent-lift-open" out:fade={{ duration: visible ? 150 : 0 }} onclick={() => (lifting = true)}>{t("agent-lift-open")}</button>{/if}
    </div>
  {/if}
  {#if lifting && masking.locked}
    <LiftLock names={masking.locked} onClose={() => (lifting = false)} />
  {/if}
  {#if uncoveredKey === "agent-mask-uncovered"}
    <p class="mask-banner" role="status" data-testid="agent-mask-uncovered" out:fade={{ duration: visible ? 150 : 0 }}>{t("agent-mask-uncovered")}</p>
  {:else if uncoveredKey}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex: the tooltip opens on focus too -->
    <p class="mask-banner tipped" role="status" tabindex="0" aria-describedby="agent-mask-uncovered-tip" data-testid="agent-mask-uncovered-passport" out:fade={{ duration: visible ? 150 : 0 }}
      onmouseenter={showTip} onfocus={showTip} onmouseleave={hideTip} onblur={hideTip}>
      {t(uncoveredKey)}
      {#if tip}<span class="mask-tip" id="agent-mask-uncovered-tip" role="tooltip" data-testid="agent-mask-uncovered-tip" out:fade={{ duration: visible ? 150 : 0 }}>{tip}</span>{/if}
    </p>
  {/if}
  {#each masking.passportUnreadable as profile (profile)}
    <div class="mask-banner lock" data-testid="agent-mask-passport-unreadable" out:fade={{ duration: visible ? 150 : 0 }}>
      <p role="status">{t("agent-mask-passport-unreadable", { profile: nameOf(profile) })}</p>
      <button class="lift-open" data-testid="agent-mask-passport-open" onclick={() => openSettings(`settings:passport:${profile}`)}>{t("agent-mask-passport-open")}</button>
    </div>
  {/each}
  {#if masking.notice}
    <p class="mask-banner" role="status" data-testid="agent-mask-notice" out:fade={{ duration: visible ? 150 : 0 }}>{masking.notice.slice(0, 300)}</p>
  {/if}
  {#if switchError}
    <p class="mask-banner" role="alert" data-testid="chat-switch-error" out:fade={{ duration: visible ? 150 : 0 }}>{t("chat-switch-failed", { message: switchError.slice(0, 300) })}</p>
  {/if}
  {#if signedOutCodex && !chatMode}
    <p class="message">{t("agent-panel-codex-signed-out")}</p>
    <button data-testid="agent-login-settings" onclick={openAgentSettings}>{t("agent-panel-login")}</button>
  {/if}
  {#if !chatMode && appState.state === "active" && appState.engineChanged}
    <!-- A fade never ends in a hidden panel (no frames): off screen, the notice leaves at once. -->
    <div class="engine-changed" data-testid="agent-engine-changed" bind:this={engineNotice} out:fade={{ duration: engineNotice?.getClientRects().length ? 150 : 0 }}>
      <p class="message">{t("agent-panel-engine-changed")}</p>
      <button data-testid="agent-engine-relaunch" onclick={() => void api.agent.relaunch()}>{t("agent-panel-restart")}</button>
    </div>
  {/if}
  {#if chatMode}
    <ChatView bind:this={chatPane} status={preparing} openSettings={openAgentSettings} />
  {:else if prep}
    {@render preparing()}
  {:else if appState.state === "docker-absent"}
    <p class="message">{t("agent-panel-docker-absent")}</p>
    <button onclick={terminalAgent.reset}>{t("agent-panel-retry")}</button>
  {:else if appState.state === "error"}
    <p class="message">{t("agent-panel-error", { message: appState.message })}</p>
    <button onclick={terminalAgent.reset}>{t("agent-panel-retry")}</button>
  {:else if appState.state === "asleep"}
    <p class="message" data-testid="agent-asleep" in:fade={{ duration: 150 }}>{t("agent-panel-asleep")}</p>
  {:else if appState.state === "done"}
    <p class="message">{t("agent-panel-done")}</p>
    <button onclick={terminalAgent.reset}>{t("agent-panel-restart")}</button>
  {/if}
  {/if}
  <!-- Asleep: a click wakes the agent too (a TUI without mouse reporting sends nothing for it). -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="terminal" bind:this={hostEl} hidden={!aiOn() || chatMode} class:masked={appState.state !== "active" && appState.state !== "done" && !waking} onpointerdown={() => appState.state === "asleep" && api.agent.write("")}></div>
  {#if terminalAgent.bubble.current && terminalAgent.bubble.current.host === hostEl}
    <MaskBubble b={terminalAgent.bubble.current} {visible} />
  {/if}
  {#if chatMode && chat.listOpen}
    <ChatList profiles={chatProfiles} />
  {/if}
  {#if aiOn() && !chatMode}
    <!-- Keys typed in the terminal go to the agent as they are (spec § 5.4 bis): said, always. -->
    <p class="typed" data-testid="agent-typed-reminder">{t("agent-mask-typed-reminder")}</p>
  {/if}
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
  /* A narrow panel shortens the agent's name, never pushes the mode switch out. */
  header select { -moz-window-dragging: no-drag; min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .orb { flex: none; width: 14px; height: 14px; border-radius: 50%; background: conic-gradient(from var(--ang), var(--a1), var(--a2), var(--a3), var(--a1)); box-shadow: 0 0 0 3px color-mix(in oklab, var(--a2) 16%, transparent); transition: box-shadow 300ms var(--out); }
  .orb.busy { animation: orb-spin 1.8s linear infinite; box-shadow: 0 0 0 3px color-mix(in oklab, var(--a2) 28%, transparent), 0 0 12px color-mix(in oklab, var(--a1) 55%, transparent); }
  @keyframes orb-spin { to { --ang: 360deg; } }
  @media (prefers-reduced-motion: reduce) { .orb.busy { animation: none; } }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 14px/1 var(--font-display); letter-spacing: -0.01em; }
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
  .mode { flex: none; display: flex; gap: 2px; padding: 2px; margin-left: auto; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); -moz-window-dragging: no-drag; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .mode button { margin: 0; padding: 4px 10px; border-radius: 8px; background: transparent; color: var(--text-muted); font: 600 12px/1.2 var(--font-ui); transition: transform var(--tap), background var(--tap), color var(--tap); }
  .mode button:disabled { opacity: 0.5; cursor: default; }
  .mode button[aria-checked="true"] { background: var(--glass); color: var(--text); box-shadow: var(--lift), inset 0 0 0 1px var(--glass-edge); }
  .engine-changed { display: flex; flex-direction: column; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  /* What masking says about this conversation: an error-tinted line set in the glass, on the spring (DESIGN.md). */
  .mask-banner { flex: none; margin: 0 8px 8px; padding: 7px 10px; border-radius: 10px; background: color-mix(in srgb, var(--in-error) 10%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--in-error) 28%, transparent); color: var(--text); font-size: 12.5px; line-height: 1.4; overflow-wrap: anywhere; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  /* The passport banner's tooltip: under the line, on the spring, out by a fade (DESIGN.md). */
  .mask-banner.tipped { position: relative; }
  .mask-tip { position: absolute; z-index: 2; left: 8px; right: 8px; top: calc(100% + 4px); padding: 6px 9px; border-radius: 8px; background: var(--glass-hi); box-shadow: 0 0 0 1px var(--border); color: var(--text); font-size: 12px; white-space: pre-line; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .mask-banner.lock { display: flex; align-items: center; gap: 8px; }
  .mask-banner.lock p { flex: 1; min-width: 0; margin: 0; }
  .mask-banner .lift-open { flex: none; margin: 0; padding: 4px 10px; font-size: 12px; }
  .terminal[hidden] { display: none; }
  .back { flex: none; margin: 0 0 0 auto; padding: 4px 10px; font-size: 12px; -moz-window-dragging: no-drag; }
  .typed { flex: none; margin: -2px 14px 6px; color: var(--text-muted); font-size: 11.5px; line-height: 1.3; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
</style>
