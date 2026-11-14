<script lang="ts">
  import type { OverlayApi, OverlayContext } from "../shared/api";
  import { format } from "../shared/i18n";
  import DesignBasket from "./components/DesignBasket.svelte";

  const api = window.ressac as unknown as OverlayApi;
  let context = $state<OverlayContext | null>(null);
  let text = $state("");
  let error = $state<string | null>(null);
  let field = $state<HTMLTextAreaElement>();
  let request = 0;
  /** This frame has no browser state: the language comes with the context. */
  const t = (id: string) => format(context?.locale ?? "fr", id);

  async function reread() {
    const n = ++request;
    const c = await api.context().catch(() => null);
    if (n !== request) return;
    // A new bubble (another element) starts from an empty text.
    if (c?.mode !== "bubble" || context?.mode !== "bubble" || c.label !== context.label || c.source !== context.source) {
      text = "";
      error = null;
    }
    context = c;
  }
  void reread();
  api.onChange(() => void reread());

  $effect(() => {
    if (context?.mode === "bubble" && field) field.focus();
  });

  async function add() {
    const r = await api.add(text);
    if (r.ok) text = "";
    else error = r.error;
  }

  function clavier(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void add();
    } else if (e.key === "Escape") {
      e.preventDefault();
      api.cancel();
    }
  }
</script>

{#if context?.mode === "bubble"}
  <div class="bubble" data-testid="design-bubble" role="dialog" aria-label={t("agent-bubble-label")}>
    <div class="head">
      <code class="tag">{context.label}</code>
      {#if context.source}<span class="source">{context.source}</span>{/if}
    </div>
    {#if context.warning}<p class="warning" data-testid="bubble-warning">{context.warning}</p>{/if}
    <textarea bind:this={field} bind:value={text} onkeydown={clavier} placeholder={t("agent-bubble-placeholder")} maxlength="4000"></textarea>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="actions">
      <button class="cancel" onclick={() => api.cancel()}>{t("agent-cancel")}</button>
      <button class="add-button" onclick={() => void add()}>{t("agent-bubble-add")} <kbd>⌘↩</kbd></button>
    </div>
  </div>
{:else if context?.mode === "message"}
  <!-- Not interactive: only a click closes it (like the next keystroke, on the main process side). -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div class="message" data-testid="message-design" role="status" onclick={() => api.cancel()}>{context.message}</div>
{:else if context?.mode === "basket"}
  <div class="pane">
    <DesignBasket {api} project={context.project} destination={context.destination} noDestination={context.noDestination} locale={context.locale} close={() => api.cancel()} />
  </div>
{/if}

<style>
  :global(html), :global(body), :global(#app) { margin: 0; height: 100%; overflow: hidden; }
  .bubble { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; background: var(--glass-dense); color: var(--text); border: 1px solid var(--accent); border-radius: 12px; font-size: 12px; animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .head { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
  .tag { color: var(--accent); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .source { color: var(--text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  textarea { flex: 1; resize: none; box-sizing: border-box; width: 100%; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: inherit; outline: none; }
  textarea:focus { border-color: var(--accent); }
  .warning { margin: 0; color: var(--text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .error { margin: 0; color: var(--in-error); }
  .actions { display: flex; justify-content: flex-end; gap: 6px; }
  button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 8px; transition: transform var(--tap), background var(--tap); }
  button:active { transform: scale(0.97); }
  .cancel { color: var(--text-muted); }
  .cancel:hover { background: var(--bg-hover); color: var(--text); }
  .add-button { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
  kbd { font: inherit; opacity: 0.8; margin-left: 4px; }
  .message { box-sizing: border-box; height: 100%; display: flex; align-items: center; padding: 8px 12px; background: var(--glass-dense); color: var(--text); border: 1px solid var(--glass-edge); border-radius: 12px; font-size: 12px; line-height: 1.35; cursor: default; overflow: hidden; }
  /* The cart column: a glass card beside the page, like the agent panel; dense, a window without aura may be behind. */
  .pane {
    box-sizing: border-box;
    height: calc(100% - 16px);
    margin: 8px 8px 8px 0;
    border: 1px solid var(--glass-edge);
    border-radius: 16px;
    background: radial-gradient(120% 50% at 0% 0%, color-mix(in oklab, var(--a1) 16%, transparent), transparent 70%), var(--glass-dense);
    box-shadow: var(--lift);
    overflow: hidden;
  }
</style>
