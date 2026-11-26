<script lang="ts">
  import type { Snippet } from "svelte";
  import { fade } from "svelte/transition";
  import { api } from "../../state.svelte";
  import { t } from "../../i18n.svelte";
  import { chat, openChat } from "./chat.svelte";
  import ChatComposer from "./ChatComposer.svelte";
  import ChatLogin from "./ChatLogin.svelte";
  import ChatThread from "./ChatThread.svelte";

  /**
   * The window's active discussion in the agent panel (the agent view « Discussion »): its thread, the panel's states
   * (`status`: preparing, build step, review card) above the composer, or the login card while its engine is signed out.
   */
  let { status, openSettings }: { status?: Snippet; openSettings: () => void } = $props();
  let composer = $state<ReturnType<typeof ChatComposer>>();
  const view = $derived(chat.view);
  const phase = $derived(view?.summary.state);

  export const focus = (): void => composer?.focus();
  export const hasFocus = (): boolean => composer?.hasFocus() ?? false;
</script>

{#if phase === "signed-out" && view}
  <ChatLogin engine={view.summary.engine} {openSettings} />
{:else}
  <ChatThread />
  <div class="states">
    {@render status?.()}
    {#if chat.error}
      <div class="line" out:fade={{ duration: chat.visible ? 150 : 0 }}>
        <p role="alert">{t("chat-open-failed", { message: chat.error })}</p>
        <button data-testid="chat-open-retry" onclick={() => void openChat()}>{t("agent-panel-retry")}</button>
      </div>
    {:else if phase === "error"}
      <div class="line" out:fade={{ duration: chat.visible ? 150 : 0 }}>
        <p role="alert">{t("chat-error", { message: view?.error ?? "" })}</p>
        <button data-testid="chat-retry" onclick={() => api.chat.retry()}>{t("agent-panel-retry")}</button>
      </div>
    {:else if phase === "queued"}
      <p class="line" role="status" out:fade={{ duration: chat.visible ? 150 : 0 }}>{t("chat-queued")}</p>
    {:else if phase === "paused"}
      <p class="line" role="status" out:fade={{ duration: chat.visible ? 150 : 0 }}>{t("chat-paused")}</p>
    {/if}
    {#if view?.waiting}
      <p class="line" role="status" out:fade={{ duration: chat.visible ? 150 : 0 }}>{t("chat-waiting", { count: view.waiting })}</p>
    {/if}
  </div>
  <ChatComposer bind:this={composer} />
{/if}

<style>
  .states { flex: none; display: flex; flex-direction: column; }
  .states:empty { display: none; }
  .line { display: flex; align-items: center; gap: 8px; margin: 0 14px 8px; color: var(--text-muted); font-size: 12.5px; line-height: 1.45; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .line p { flex: 1; margin: 0; }
  button { flex: none; padding: 5px 12px; border-radius: 10px; border: 0; background: var(--accent); color: var(--accent-ink); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
