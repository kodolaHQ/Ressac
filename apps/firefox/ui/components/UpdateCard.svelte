<script lang="ts">
  import { fade } from "svelte/transition";
  import { showUpdateCard, updateCardTitle } from "../../core/update";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";

  /** A downloaded update waits for a restart; « Plus tard » hides the card in every window until the next launch. */
  const update = $derived(appState.value?.update ?? null);
</script>

{#if showUpdateCard(update)}
  <aside class="card" data-testid="update-card" out:fade={{ duration: 150 }}>
    <b>{updateCardTitle(update!.version, appState.value?.locale ?? "fr")}</b>
    <p>{t("sidebar-update-installs")}</p>
    <div class="row">
      <button type="button" class="primary" data-testid="update-restart" onclick={() => api.settings.restartToUpdate()}>{t("sidebar-update-restart")}</button>
      <button type="button" data-testid="update-later" onclick={() => api.dispatch({ type: "dismissUpdate" })}>{t("sidebar-update-later")}</button>
    </div>
  </aside>
{/if}

<style>
  /* A glass card above the footer: enter spring, exit fade (DESIGN.md). */
  .card { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; padding: 12px 14px; border-radius: 16px; border: 1px solid var(--glass-edge); background: var(--glass); box-shadow: var(--float); color: var(--text); -moz-window-dragging: no-drag; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  b { font: 600 13px var(--font-ui); }
  p { margin: 0; font-size: 12.5px; line-height: 1.4; color: var(--text-muted); }
  .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  button { padding: 5px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  button:hover { background: var(--bg-active); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
</style>
