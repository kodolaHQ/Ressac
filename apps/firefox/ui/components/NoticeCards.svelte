<script lang="ts">
  import { fade } from "svelte/transition";
  import type { Notice } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";

  /** The start-up notices (chrome/store/index.ts), in every window until answered; answering removes them everywhere. */
  const notices = $derived(appState.value?.notices ?? []);
  const text = (n: Notice): string =>
    n.id === "session-set-aside" ? t("chrome-session-set-aside", { path: n.path }) : n.id === "data-set-aside" ? t(n.reason === "reset" ? "chrome-data-reset" : "chrome-data-unknown-format", { backup: n.backup }) : t("agent-telemetry-notice");
  const dismiss = (n: Notice) => api.dispatch({ type: "dismissNotice", id: n.id });
</script>

{#each notices as n (n.id)}
  <aside class="card" data-testid="notice-card" data-notice={n.id} out:fade={{ duration: 150 }}>
    <p>{text(n)}</p>
    <div class="row">
      {#if n.id === "telemetry"}
        <button type="button" data-testid="notice-telemetry-stop" onclick={() => (api.settings.setTelemetry(false), dismiss(n))}>{t("chrome-telemetry-stop")}</button>
      {/if}
      <button type="button" class="primary" data-testid="notice-ok" onclick={() => dismiss(n)}>{t("chrome-telemetry-ok")}</button>
    </div>
  </aside>
{/each}

<style>
  /* The update card's glass card (UpdateCard.svelte): enter spring, exit fade (DESIGN.md). */
  .card { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; padding: 12px 14px; border-radius: 16px; border: 1px solid var(--glass-edge); background: var(--glass); box-shadow: var(--float); color: var(--text); -moz-window-dragging: no-drag; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  p { margin: 0; font-size: 12.5px; line-height: 1.4; color: var(--text); overflow-wrap: anywhere; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  button { padding: 5px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  button:hover { background: var(--bg-active); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
</style>
