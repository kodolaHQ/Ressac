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
  <aside class="sidebar-card" data-testid="notice-card" data-notice={n.id} out:fade={{ duration: 150 }}>
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
  /* The card itself: .sidebar-card in theme.css. The notice is the whole message: full text colour, long paths wrap. */
  .sidebar-card p { color: var(--text); overflow-wrap: anywhere; }
</style>
