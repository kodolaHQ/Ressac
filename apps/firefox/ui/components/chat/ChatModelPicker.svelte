<script lang="ts">
  import { fade } from "svelte/transition";
  import type { ChatModel } from "../../../shared/chat";
  import { api } from "../../state.svelte";
  import { t } from "../../i18n.svelte";
  import { chat } from "./chat.svelte";

  /**
   * The model picker in the composer's bottom row: the engine's own list read from the host when it opens (loading, then
   * the list or a quiet error line). A pick applies from the next message and becomes the engine's default for new
   * discussions. Shown only when the view carries a model (Réglages' model applies otherwise).
   */
  let open = $state(false);
  let wrap = $state<HTMLElement>();
  let models = $state<ChatModel[] | null>(null);
  let error = $state<string | null>(null);
  let picking = $state<string | null>(null);
  const current = $derived(chat.view?.model);
  const nameOf = (m: { value: string; name: string }) => m.name || t("chat-model-default");
  /** Only the latest read applies: an older answer never replaces a newer one. */
  let reads = 0;
  async function toggle() {
    open = !open;
    if (!open) return;
    const n = ++reads;
    models = error = null;
    const r = await api.chat.models();
    if (n !== reads) return;
    if (r.ok) models = r.models;
    else error = r.error;
  }
  async function pick(value: string) {
    const engine = chat.view?.summary.engine;
    picking = value;
    const r = await api.chat.setModel(value);
    picking = null;
    if (!r.ok) return void (error = r.error);
    open = false;
    if (r.own) api.dispatch({ type: "chooseOwnEngine", engine: r.own });
    else if (engine === "claude" || engine === "codex") api.dispatch({ type: "chooseChatModel", engine, model: value });
  }
  // Another discussion: the menu closes (a new view of the same one does not).
  const id = $derived(chat.view?.summary.id);
  $effect(() => {
    void id;
    open = false;
  });
  // A press outside the menu or Échap closes it.
  $effect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !wrap?.contains(e.target as Node) && (open = false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && (open = false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  });
</script>

{#if current}
  <div class="wrap" bind:this={wrap}>
    <button type="button" class="chip" data-testid="chat-model-chip" aria-haspopup="menu" aria-expanded={open} aria-label={`${t("chat-model")} : ${nameOf(current)}`} title={nameOf(current)} onclick={() => void toggle()}>
      <span class="name">{nameOf(current)}</span>
    </button>
    {#if open}
      <div class="menu" role="menu" aria-label={t("chat-model")} data-testid="chat-model-menu" out:fade={{ duration: chat.visible ? 150 : 0 }}>
        {#if models}
          {#each models as m (m.value)}
            <button type="button" role="menuitemradio" aria-checked={current.value === m.value} data-testid="chat-model-{m.value || 'default'}" disabled={picking !== null} onclick={() => void pick(m.value)}>
              {nameOf(m)}{#if m.cloud}{" · "}<span class="remote" title={t("chat-engine-own-remote-title", { host: m.cloud })}>{t("chat-engine-own-remote")}</span>{/if}
              {#if m.description}<small>{m.description}</small>{/if}
            </button>
          {/each}
        {:else if !error}
          <p role="status" data-testid="chat-model-loading">{t("chat-model-loading")}</p>
        {/if}
        {#if error}<p class="error" role="status" data-testid="chat-model-error">{error}</p>{/if}
        <p>{t("chat-model-note")}</p>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Shrinks before the Send button does: the name ends in an ellipsis, the full name is the title. */
  .wrap { position: relative; min-width: 0; flex: 0 1 auto; max-width: 60%; }
  .chip { display: flex; max-width: 100%; padding: 3px 8px; border-radius: 999px; border: 0; background: var(--bg-hover); color: var(--text-muted); font: 11.5px/1.4 var(--font-ui); cursor: pointer; transition: transform var(--tap), color var(--tap); }
  .chip:hover { color: var(--text); }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Opens upward, above the composer, aligned on the chip's right edge. */
  .menu { position: absolute; z-index: 5; right: 0; bottom: calc(100% + 6px); width: max-content; min-width: 220px; max-width: min(300px, calc(100vw - 24px)); max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: 12px; background: var(--glass-dense); box-shadow: var(--float), inset 0 0 0 1px var(--glass-edge); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .menu button { padding: 6px 10px; border-radius: 8px; border: 0; background: transparent; color: var(--text); font: 13px/1.3 var(--font-ui); text-align: left; cursor: pointer; overflow-wrap: anywhere; transition: transform var(--tap), background var(--tap); }
  .menu button:hover:not(:disabled) { background: var(--bg-hover); }
  .menu button[aria-checked="true"] { background: var(--bg-active); font-weight: 600; }
  .menu button:disabled { opacity: 0.5; cursor: default; }
  .menu small { display: block; color: var(--text-muted); font-size: 11.5px; font-weight: 400; }
  .menu p { margin: 4px 10px 2px; color: var(--text-muted); font-size: 11.5px; }
  .menu p.error { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .remote { color: var(--in-progress); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
