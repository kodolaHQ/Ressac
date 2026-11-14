<script lang="ts">
  import { fade } from "svelte/transition";
  import { api } from "../state.svelte";
  import { t } from "../i18n.svelte";

  /** Shown instead of an AI feature while settings.aiEnabled is off: what it does, and the way to turn AI on. */
  let { feature }: { feature: "agent" | "apps" | "actions" | "widgets" | "workflows" | "review" | "settings" } = $props();
  let card: HTMLElement;
</script>

<!-- A fade never ends in a hidden panel (no frames): a card that is not on screen leaves at once, else it stays over the agent. -->
<aside class="asleep" data-testid="ai-asleep-{feature}" bind:this={card} out:fade={{ duration: card?.getClientRects().length ? 150 : 0 }}>
  <b>{t("ai-asleep-title")}</b>
  <p>{t(`ai-asleep-${feature}`)}</p>
  <div class="row">
    <button type="button" class="primary" data-testid="ai-asleep-enable" onclick={() => api.dispatch({ type: "enableAi" })}>{t("ai-asleep-enable")}</button>
    <!-- Only the agent panel has something to close. -->
    {#if feature === "agent"}
      <button type="button" data-testid="ai-asleep-later" onclick={() => api.dispatch({ type: "toggleAgentPanel", windowId: api.windowId })}>{t("ai-asleep-later")}</button>
    {/if}
  </div>
</aside>

<style>
  .asleep { display: flex; flex-direction: column; gap: 8px; width: min(420px, calc(100% - 28px)); box-sizing: border-box; margin: 24px auto; padding: 16px 18px; border-radius: 16px; border: 1px solid var(--glass-edge); background: var(--glass); box-shadow: var(--float); color: var(--text); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  b { font: 600 15px/1.2 var(--font-display); letter-spacing: -0.01em; }
  p { margin: 0; font-size: 14px; line-height: 1.45; color: var(--text-muted); }
  .row { display: flex; gap: 8px; margin-top: 4px; }
  button { padding: 6px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 13px var(--font-ui); cursor: pointer; transition: transform var(--tap), background var(--tap); }
  button:hover { background: var(--bg-active); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
</style>
