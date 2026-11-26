<script lang="ts">
  import { tick } from "svelte";
  import { fade } from "svelte/transition";
  import type { ChatSummary } from "../../../shared/chat";
  import { appState } from "../../state.svelte";
  import { t } from "../../i18n.svelte";
  import Icon from "../Icon.svelte";
  import { chat, chatTitle, newChat, openChat, removeChat } from "./chat.svelte";

  let { profiles }: { profiles: { id: string; name: string }[] } = $props();
  let panel = $state<HTMLElement>();

  const live = $derived(chat.list.filter((s) => s.state !== "paused"));
  const paused = $derived(chat.list.filter((s) => s.state === "paused"));
  const engineName = (s: ChatSummary) => profiles.find((p) => p.id === s.profile)?.name ?? (s.engine === "codex" ? "Codex" : s.engine === "own" ? t("chat-engine-own") : "Claude");

  /** « il y a 5 min », « hier »: in the shown language. */
  function ago(at: number): string {
    const rtf = new Intl.RelativeTimeFormat(appState.value?.locale ?? "fr", { numeric: "auto", style: "short" });
    const minutes = Math.round((Date.now() - at) / 60_000);
    if (minutes < 1) return t("chat-list-now");
    if (minutes < 60) return rtf.format(-minutes, "minute");
    if (minutes < 24 * 60) return rtf.format(-Math.round(minutes / 60), "hour");
    return rtf.format(-Math.round(minutes / (24 * 60)), "day");
  }
  const dot = (s: ChatSummary) => (s.state === "waiting" ? "waiting" : s.state === "running" || s.state === "starting" ? "running" : s.state === "error" || s.state === "signed-out" ? "error" : "done");
  function line(s: ChatSummary): string {
    switch (s.state) {
      case "waiting":
        return t("chat-list-waiting");
      case "running":
        return t("chat-list-running");
      case "starting":
        return t("chat-list-starting");
      case "queued":
        return t("chat-list-queued");
      case "error":
        return t("chat-list-error");
      case "signed-out":
        return t("chat-list-signed-out");
      default:
        return t("chat-list-done", { ago: ago(s.updatedAt) });
    }
  }
  const close = () => (chat.listOpen = false);
  function pick(id: string) {
    close();
    if (id !== chat.view?.summary.id) void openChat(id);
  }
  function fresh() {
    close();
    void newChat();
  }
  // The list takes the keyboard on its first row (or « Nouvelle »), Échap gives it back.
  $effect(() => void tick().then(() => panel?.querySelector<HTMLElement>(".row, .new")?.focus()));

  /** The discussion whose deletion waits for the dialog; `opener`, the button focus goes back to. */
  let toDelete = $state<{ s: ChatSummary; opener: HTMLElement | null; history: boolean } | null>(null);
  let dialog = $state<HTMLElement>();
  let notice = $state<string | null>(null);
  function askDelete(s: ChatSummary, e: MouseEvent) {
    notice = null;
    toDelete = { s, opener: e.currentTarget as HTMLElement, history: true };
    void tick().then(() => dialog?.querySelector<HTMLElement>("[data-cancel]")?.focus());
  }
  function closeDialog() {
    const opener = toDelete?.opener;
    toDelete = null;
    void tick().then(() => (opener?.isConnected ? opener : panel?.querySelector<HTMLElement>(".row, .new"))?.focus());
  }
  async function confirmDelete() {
    const d = toDelete!;
    toDelete = null;
    notice = await removeChat(d.s.id, d.history && !!d.s.engineHistory);
    void tick().then(() => panel?.querySelector<HTMLElement>(".row, .new")?.focus());
  }
  /** Échap and Annuler close it; the rest of the list is inert meanwhile. */
  function dialogKeys(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeDialog();
  }
</script>

{#snippet remove(s: ChatSummary)}
  <button class="delete" aria-label={t("chat-delete", { title: chatTitle(s.title) })} title={t("chat-delete", { title: chatTitle(s.title) })} data-testid="chat-row-delete" onclick={(e) => askDelete(s, e)}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></svg>
  </button>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="list" data-testid="chat-list" aria-label={t("chat-list-title")} bind:this={panel} out:fade={{ duration: chat.visible ? 150 : 0 }} onkeydown={(e) => e.key === "Escape" && (e.stopPropagation(), close())}>
  <header inert={!!toDelete}>
    <button class="icon" aria-label={t("chat-list-close")} title={t("chat-list-close")} data-testid="chat-list-close" onclick={close}><Icon name="back" size={15} /></button>
    <strong>{t("chat-list-title")}</strong>
    <span class="spacer"></span>
    <button class="new" data-testid="chat-list-new" onclick={fresh}><Icon name="plus" size={13} />{t("chat-list-new")}</button>
  </header>
  <div class="rows" inert={!!toDelete}>
    {#if live.length}
      <span class="group">{t("chat-list-live")}</span>
      {#each live as s (s.id)}
        <div class="item" class:current={s.id === chat.view?.summary.id} out:fade={{ duration: chat.visible ? 150 : 0 }}>
          <button class="row" data-testid="chat-row" onclick={() => pick(s.id)}>
            <span class="top"><span class="dot {dot(s)}" aria-hidden="true"></span><strong>{chatTitle(s.title)}</strong><span class="side">{engineName(s)}</span></span>
            <span class="sub">{line(s)}</span>
          </button>
          {@render remove(s)}
        </div>
      {/each}
    {/if}
    {#if paused.length}
      <span class="group">{t("chat-list-paused")}</span>
      {#each paused as s (s.id)}
        <div class="item" class:current={s.id === chat.view?.summary.id} out:fade={{ duration: chat.visible ? 150 : 0 }}>
          <button class="row paused" data-testid="chat-row" onclick={() => pick(s.id)}>
            <span class="top"><strong>{chatTitle(s.title)}</strong><span class="side">{ago(s.updatedAt)}</span></span>
            <span class="sub">{t("chat-list-messages", { count: s.messages })}</span>
          </button>
          {@render remove(s)}
        </div>
      {/each}
    {/if}
    {#if !chat.list.length}<p class="empty">{t("chat-list-empty")}</p>{/if}
  </div>
  {#if notice}<p class="notice" role="status" data-testid="chat-delete-notice" out:fade={{ duration: chat.visible ? 150 : 0 }}>{notice}</p>{/if}
  <p class="footer">{t("chat-list-footer")}</p>
  {#if toDelete}
    {@const d = toDelete}
    <div class="veil" out:fade={{ duration: chat.visible ? 150 : 0 }}>
      <div class="dialog" tabindex="-1" role="alertdialog" aria-modal="true" aria-labelledby="chat-delete-title" aria-describedby="chat-delete-text" data-testid="chat-delete-dialog" bind:this={dialog} onkeydown={dialogKeys}>
        <strong id="chat-delete-title">{t("chat-delete-title")}</strong>
        <p id="chat-delete-text">{t("chat-delete-text")}</p>
        {#if d.s.engineHistory}
          <label class="check"><input type="checkbox" data-testid="chat-delete-history" bind:checked={toDelete.history} />{t("chat-delete-history", { engine: d.s.engine === "codex" ? "Codex" : "Claude Code" })}</label>
        {/if}
        <div class="buttons">
          <button data-cancel data-testid="chat-delete-cancel" onclick={closeDialog}>{t("chat-delete-cancel")}</button>
          <button class="confirm" data-testid="chat-delete-confirm" onclick={() => void confirmDelete()}>{t("chat-delete-confirm")}</button>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  /* Over the whole panel, on the spring; out by a fade (DESIGN.md). */
  .list { position: absolute; inset: 0; z-index: 4; display: flex; flex-direction: column; background: var(--glass-dense); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); -moz-window-dragging: drag; }
  strong { font-size: 13px; }
  .spacer { flex: 1; }
  button { -moz-window-dragging: no-drag; cursor: pointer; transition: transform var(--tap), background var(--tap); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .icon { width: 30px; height: 30px; display: grid; place-items: center; padding: 0; border-radius: 10px; border: 1px solid var(--border); background: transparent; color: var(--text); }
  .new { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 10px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); font: 600 12.5px var(--font-ui); }
  .rows { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 10px; }
  .group { padding: 6px 8px 2px; color: var(--text-muted); font-size: 11.5px; }
  .group:not(:first-child) { padding-top: 14px; }
  .row { display: flex; flex-direction: column; align-items: stretch; gap: 3px; padding: 10px 12px; border-radius: 10px; border: 0; background: transparent; color: var(--text); text-align: left; font: 13px/1.4 var(--font-ui); }
  .item { display: flex; align-items: center; border-radius: 10px; transition: background var(--tap); }
  .item:hover { background: var(--bg-hover); }
  .item.current { background: var(--bg-active); }
  .item .row { flex: 1; min-width: 0; }
  /* Shown on hover or focus; still in the Tab order, so the keyboard always reaches it. */
  .delete { flex: none; width: 28px; height: 28px; margin-right: 6px; display: grid; place-items: center; padding: 0; border-radius: 8px; border: 0; background: transparent; color: var(--text-muted); opacity: 0; transition: opacity var(--tap), background var(--tap); }
  .item:hover .delete, .delete:focus-visible { opacity: 1; }
  .delete:hover { background: var(--glass-hi); color: var(--in-error); }
  .veil { position: absolute; inset: 0; z-index: 1; display: grid; place-content: center; padding: 16px; background: var(--veil); backdrop-filter: blur(6px); }
  .dialog { display: flex; flex-direction: column; gap: 10px; max-width: 340px; padding: 18px 20px; border-radius: 16px; background: var(--glass-dense); border: 1px solid var(--glass-edge); box-shadow: var(--modal-shadow); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .dialog p { margin: 0; color: var(--text-muted); }
  .check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .buttons button { padding: 6px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); }
  .buttons .confirm { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .notice { margin: 0; padding: 8px 16px; color: var(--text-muted); font-size: 12px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .top { display: flex; align-items: center; gap: 8px; }
  .top strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .side, .sub { color: var(--text-muted); font-size: 11.5px; }
  .sub { font-size: 12px; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
  .dot.waiting { background: var(--in-progress); }
  .dot.running { background: var(--running); }
  .dot.done { background: var(--stopped); }
  .dot.error { background: var(--in-error); }
  .empty { margin: 8px; color: var(--text-muted); }
  .footer { margin: 0; padding: 10px 16px 14px; color: var(--text-muted); font-size: 11.5px; border-top: 1px solid var(--border); }
</style>
