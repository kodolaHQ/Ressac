<script lang="ts">
  import { fade } from "svelte/transition";
  import { showUpdateCard, updateCardTitle } from "../../core/update";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";

  /** A downloaded update waits for a restart; « Plus tard » hides the card in every window until the next launch. */
  const update = $derived(appState.value?.update ?? null);
</script>

{#if showUpdateCard(update)}
  <aside class="sidebar-card" data-testid="update-card" out:fade={{ duration: 150 }}>
    <b>{updateCardTitle(update!.version, appState.value?.locale ?? "fr")}</b>
    <p>{t("sidebar-update-installs")}</p>
    <div class="row">
      <button type="button" class="primary" data-testid="update-restart" onclick={() => api.settings.restartToUpdate()}>{t("sidebar-update-restart")}</button>
      <button type="button" data-testid="update-later" onclick={() => api.dispatch({ type: "dismissUpdate" })}>{t("sidebar-update-later")}</button>
    </div>
  </aside>
{/if}

<style>
  /* The card itself: .sidebar-card in theme.css. */
  b { font: 600 13px var(--font-ui); }
</style>
