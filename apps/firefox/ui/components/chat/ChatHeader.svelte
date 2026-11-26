<script lang="ts">
  import { fade } from "svelte/transition";
  import { api, labOn } from "../../state.svelte";
  import { t } from "../../i18n.svelte";
  import Icon from "../Icon.svelte";
  import { chat, newChat, readList } from "./chat.svelte";

  /** `profiles`: the agents a discussion can run (Claude Code, Codex); `onAdvanced`: « Mode avancé ». */
  let { profiles, onAdvanced }: { profiles: { id: string; name: string }[]; onAdvanced: () => void } = $props();

  const summary = $derived(chat.view?.summary);
  const engineName = (id: string | undefined) => profiles.find((p) => p.id === id)?.name ?? (id === "codex" ? "Codex" : id === "own" ? t("chat-engine-own") : "Claude");
  // « Votre modèle » runs in Navigateur only, without a terminal: whatever mode its record carries.
  const own = $derived(summary?.engine === "own");
  const modeName = (m: "browser" | "workshop") => t(`agent-panel-mode-${m}`);
  let menuOpen = $state(false);
  let menu = $state<HTMLElement>();

  function toggleList() {
    chat.listOpen = !chat.listOpen;
    if (chat.listOpen) void readList();
  }
  /** A new mode or agent starts a new discussion, as switching relaunched the terminal. */
  function choose(o: { profile?: string; mode?: "browser" | "workshop" }) {
    menuOpen = false;
    if (o.mode) api.dispatch({ type: "chooseAgentMode", mode: o.mode });
    const profile = o.profile ?? summary?.profile;
    void newChat({ profile, mode: profile === "own" ? "browser" : (o.mode ?? summary?.mode) });
  }
  // A press outside the menu or Échap closes it.
  $effect(() => {
    if (!menuOpen) return;
    const away = (e: PointerEvent) => !menu?.contains(e.target as Node) && (menuOpen = false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && (menuOpen = false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  });
</script>

<header>
  <button class="picker" data-testid="chat-picker" aria-haspopup="true" aria-expanded={chat.listOpen} title={t("chat-picker")} onclick={toggleList}>
    <span class="title">{summary?.title || t("chat-untitled")}</span>
    <span class="down"><Icon name="chevron" size={12} /></span>
  </button>
  <span class="spacer"></span>
  {#if summary}
    <div class="chip-wrap" bind:this={menu}>
      <button class="chip" data-testid="chat-mode-chip" aria-haspopup="menu" aria-expanded={menuOpen} title={t("chat-menu")} onclick={() => (menuOpen = !menuOpen)}>
        {modeName(own ? "browser" : summary.mode)} · {engineName(summary.profile)}{#if own && chat.view?.remote}
          · <span class="remote" data-testid="chat-engine-remote" title={t("chat-engine-own-remote-title", { host: chat.view.remote })}>{t("chat-engine-own-remote")}</span>{/if}
      </button>
      {#if menuOpen}
        <div class="menu" role="menu" aria-label={t("chat-menu")} out:fade={{ duration: chat.visible ? 150 : 0 }}>
          {#each ["browser", "workshop"] as const as m (m)}
            {@const locked = m === "workshop" && !labOn()}
            <button role="menuitemradio" aria-checked={(own ? "browser" : summary.mode) === m} data-testid="chat-mode-{m}" disabled={locked || (own && m === "workshop")} title={t(locked ? "agent-panel-mode-workshop-lab-title" : `agent-panel-mode-${m}-title`)} onclick={() => choose({ mode: m })}>
              {t(locked ? "agent-panel-mode-workshop-lab" : `agent-panel-mode-${m}`)}
            </button>
          {/each}
          {#if profiles.length >= 2}
            <hr />
            {#each profiles as p (p.id)}
              <button role="menuitemradio" aria-checked={summary.profile === p.id} data-testid="chat-profile-{p.id}" onclick={() => choose({ profile: p.id })}>{p.name}</button>
            {/each}
          {/if}
          <p>{t("chat-menu-note")}</p>
        </div>
      {/if}
    </div>
  {/if}
  <button class="icon" data-testid="chat-new" aria-label={t("chat-new")} title={t("chat-new")} onclick={() => void newChat()}><Icon name="plus" size={15} /></button>
  {#if !own}
    <button class="icon muted" data-testid="chat-advanced" aria-label={t("chat-advanced")} title={t("chat-advanced")} onclick={onAdvanced}><Icon name="terminal" size={15} /></button>
  {/if}
</header>

<style>
  /* The panel's header moves the window, its controls aside. */
  header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex: none; border-bottom: 1px solid var(--border); -moz-window-dragging: drag; }
  button { -moz-window-dragging: no-drag; cursor: pointer; transition: transform var(--tap), background var(--tap), border-color var(--tap); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .picker { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 6px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 13px/1.2 var(--font-ui); }
  .picker:hover { border-color: var(--glass-edge); }
  .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .down { flex: none; transform: rotate(90deg); color: var(--text-muted); }
  .spacer { flex: 1; }
  .chip-wrap { position: relative; flex: none; }
  .chip { padding: 3px 8px; border-radius: 999px; border: 0; background: var(--bg-hover); color: var(--text-muted); font: 11.5px/1.4 var(--font-ui); white-space: nowrap; }
  .chip:hover { color: var(--text); }
  .remote { color: var(--in-progress); }
  .icon { flex: none; width: 30px; height: 30px; display: grid; place-items: center; padding: 0; border-radius: 10px; border: 1px solid var(--border); background: transparent; color: var(--text); }
  .icon.muted { color: var(--text-muted); }
  .icon:hover { background: var(--bg-hover); }
  .menu { position: absolute; z-index: 5; right: 0; top: calc(100% + 6px); min-width: 200px; display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: 12px; background: var(--glass-dense); box-shadow: var(--float), inset 0 0 0 1px var(--glass-edge); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .menu button { padding: 6px 10px; border-radius: 8px; border: 0; background: transparent; color: var(--text); font: 13px/1.3 var(--font-ui); text-align: left; }
  .menu button:hover:not(:disabled) { background: var(--bg-hover); }
  .menu button[aria-checked="true"] { background: var(--bg-active); font-weight: 600; }
  .menu button:disabled { opacity: 0.5; cursor: default; }
  .menu hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--border); }
  .menu p { margin: 4px 10px 2px; color: var(--text-muted); font-size: 11.5px; }
</style>
