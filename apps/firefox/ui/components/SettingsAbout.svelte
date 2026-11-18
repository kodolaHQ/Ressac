<script lang="ts">
  import { updateStatusText } from "../../core/update";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  // Styles come from Settings.svelte.
  const s = api.settings;
  const update = $derived(appState.value?.update ?? null);
  let version = $state<string | null>(null);
  $effect(() => void s.version().then((t) => (version = t)));
</script>

<section data-testid="settings-about" aria-label={t("settings-section-about")}>
  <div class="group">
    <SettingsRow label={t("settings-about-version")}>
      <b class="version" data-testid="app-version">{version === null ? "" : `Ressac ${version}`}</b>
      <button data-testid="settings-release-notes" onclick={() => api.dispatch({ type: "openReleaseNotes", windowId: api.windowId })}>{t("settings-about-release-notes")}</button>
    </SettingsRow>
    {#if update && update.phase !== "disabled"}
      <SettingsRow label={t("settings-about-update")}>
        <span data-testid="update-status" aria-live="polite">{updateStatusText(update, appState.value?.locale ?? "fr")}</span>
        {#if update.phase === "idle" || update.phase === "unreachable"}
          <button data-testid="update-check" onclick={() => s.checkForUpdate()}>{t("settings-about-update-check")}</button>
        {:else if update.phase === "ready"}
          <button class="primary" data-testid="update-restart" onclick={() => s.restartToUpdate()}>{t("settings-about-update-restart")}</button>
        {:else if update.phase === "failed" || update.phase === "unwritable"}
          <button data-testid="update-download" onclick={() => s.downloadUpdate()}>{t("settings-about-update-download")}</button>
        {/if}
      </SettingsRow>
    {/if}
    <SettingsRow label="">
      <button data-testid="settings-replay-welcome" onclick={() => api.dispatch({ type: "replayOnboarding" })}>{t("settings-about-replay-welcome")}</button>
      <button data-testid="open-advanced" onclick={() => s.openAdvanced()}>{t("settings-about-advanced")}</button>
    </SettingsRow>
  </div>
  <h3 class="group-title">{t("settings-credits")}</h3>
  <div class="group credits" data-testid="settings-credits">
    <p>{t("settings-credits-built-on-before")} <b>Firefox</b> {t("settings-credits-built-on-after")}</p>
    <p class="muted">{t("settings-credits-licenses-before")} <code>Contents/Resources/ressac-host/LICENSES</code>.</p>
  </div>
</section>
